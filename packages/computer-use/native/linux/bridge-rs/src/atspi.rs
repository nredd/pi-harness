//! Minimal, dependency-light AT-SPI2 client built on zbus.
//!
//! Linux desktop accessibility is intentionally used in preference to global
//! pointer/keyboard injection: Action and EditableText calls are delivered to
//! applications in the background and do not steal focus.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedObjectPath;
use zbus::{Address, Connection, Proxy};

use crate::x11::InputState;
use crate::{ErrorCode, ProtocolError};

const DBUS_DESTINATION: &str = "org.freedesktop.DBus";
const DBUS_ROOT: &str = "/org/freedesktop/DBus";
const DBUS_INTERFACE: &str = "org.freedesktop.DBus";
const REGISTRY_DESTINATION: &str = "org.a11y.atspi.Registry";
const REGISTRY_ROOT: &str = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
// AtspiRole wire IDs from atspi/atspi-constants.h in GNOME/at-spi2-core.
const PASSWORD_TEXT_ROLE: u32 = 40;
const PROTECTED_LABEL: &str = "[protected]";
const MAX_ATSPI_ACTIONS: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
pub const TEXT: &str = "org.a11y.atspi.Text";
/// The procfs mount that attributes an accessibility bus PID to its executable.
pub const PROC_ROOT: &str = "/proc";
/// Bus proxies whose connection PID is not the application's, e.g. Flatpak's
/// accessibility bus proxy, which every sandboxed app shares.
const BUS_PROXY_EXECUTABLES: [&str; 1] = ["xdg-dbus-proxy"];
/// Role names that contradict a readable numeric role.
const PROTECTED_ROLE_NAMES: [&str; 3] = ["unknown", "invalid", "password text"];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AccessibleRef {
    pub destination: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A root's policy identity: the executable of the process owning its bus connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Executable {
    /// The reported identity: the `exe` link basename without one kernel ` (deleted)` suffix.
    pub name: String,
    /// The literal `exe` link basename. It differs from `name` only when the link ends in
    /// ` (deleted)`: a replaced binary or a file literally named so. Both names can block.
    pub link_name: String,
}

impl Executable {
    /// Names that may only add a block, never admit: the literal link name when it differs.
    pub fn block_aliases(&self) -> Vec<&str> {
        if self.link_name == self.name {
            Vec::new()
        } else {
            vec![self.link_name.as_str()]
        }
    }
}

#[derive(Debug, Clone)]
pub struct RootSnapshot {
    pub accessible: AccessibleRef,
    pub pid: u64,
    pub name: String,
    pub app_name: String,
    /// The policy identity: the executable of the root's own bus owner, `None` when unattributable.
    pub executable: Option<Executable>,
    /// X11 `WM_CLASS` (instance, class) of the paired window. App-supplied metadata, not identity.
    pub wm_class: Option<(String, String)>,
    /// `WM_CLASS` of every window tied for an ambiguous pairing: never attributed to the root,
    /// only reported as block-only aliases, since a class can add a block but never admit.
    pub class_candidates: Vec<(String, String)>,
    pub role: String,
    pub frame: Option<Rect>,
    pub x11_window: Option<u32>,
    pub is_focused: bool,
    pub is_minimized: bool,
    pub z_order: Option<usize>,
}

/// The live owner of an exact root and the fresh metadata its X11 pairing ranks against.
#[derive(Debug, Clone)]
pub struct LiveRoot {
    pub pid: u64,
    pub executable: Option<Executable>,
    /// The live accessible name, empty when unreadable or protected: no title evidence.
    pub name: String,
    /// The live screen extents, `None` when unreadable: no geometry evidence.
    pub frame: Option<Rect>,
}

#[derive(Debug, Clone)]
pub struct NodeSnapshot {
    pub reference: String,
    pub accessible: AccessibleRef,
    pub parent: Option<AccessibleRef>,
    pub name: String,
    pub role: String,
    pub description: String,
    pub value: String,
    pub interfaces: HashSet<String>,
    pub bounds: Option<Rect>,
    pub is_secure: bool,
    pub depth: usize,
    /// A field or the children of this node were not read, so the outline marks it `truncated`.
    pub unread: bool,
}

/// A best-effort tree plus the information needed to distinguish absence from missing data.
#[derive(Debug)]
pub struct Snapshot {
    pub nodes: Vec<NodeSnapshot>,
    pub incomplete: bool,
    pub root_fields_incomplete: bool,
}

impl NodeSnapshot {
    #[cfg(test)]
    pub(crate) fn minimal(accessible: AccessibleRef) -> Self {
        Self {
            reference: String::new(),
            accessible,
            parent: None,
            name: String::new(),
            role: String::new(),
            description: String::new(),
            value: String::new(),
            interfaces: HashSet::new(),
            bounds: None,
            is_secure: false,
            depth: 0,
            unread: false,
        }
    }

    pub fn searchable_text(&self) -> String {
        format!("{} {} {}", self.name, self.description, self.value).to_lowercase()
    }
}

#[derive(Clone)]
pub struct AtspiClient {
    connection: Connection,
    request_timeout: Duration,
    /// Its shutdown flag is checked at each semantic mutation.
    input: Arc<InputState>,
    /// The procfs mount used to attribute root PIDs to executables.
    proc_root: Arc<Path>,
}

impl AtspiClient {
    pub async fn connect() -> Result<Self, ProtocolError> {
        let session = wait_for_reply(
            REQUEST_TIMEOUT,
            "session bus connection",
            Connection::session(),
        )
        .await?
        .map_err(unavailable)?;
        let address = accessibility_bus_address(&session, REQUEST_TIMEOUT).await?;
        let builder = zbus::connection::Builder::address(address).map_err(unavailable)?;
        let connection = wait_for_reply(
            REQUEST_TIMEOUT,
            "accessibility bus connection",
            builder.build(),
        )
        .await?
        .map_err(unavailable)?;
        Ok(Self::from_connection(connection, REQUEST_TIMEOUT))
    }

    /// Use an established accessibility connection with a per-request deadline, and
    /// the helper-wide input state's shutdown flag.
    pub fn from_connection(connection: Connection, request_timeout: Duration) -> Self {
        Self {
            connection,
            request_timeout,
            input: InputState::shared(),
            proc_root: Arc::from(Path::new(PROC_ROOT)),
        }
    }

    /// Check `input`'s shutdown flag at each semantic mutation instead, e.g. in tests.
    pub fn with_input_state(self, input: Arc<InputState>) -> Self {
        Self { input, ..self }
    }

    /// Attribute root PIDs through another procfs tree, e.g. a test fixture.
    pub fn with_proc_root(self, proc_root: &Path) -> Self {
        Self {
            proc_root: Arc::from(proc_root),
            ..self
        }
    }

    /// Refuse a semantic mutation once shutdown began. Checked right before `DoAction`
    /// or `SetTextContents`, after every preparatory request, so an action admitted
    /// before shutdown never first mutates the UI after it; a mutation already sent
    /// finishes and is never replayed.
    fn admit_mutation(&self) -> Result<(), ProtocolError> {
        if self.input.is_cancelled() {
            return Err(ProtocolError::new(
                "Helper is shutting down; the semantic action did not run",
                ErrorCode::Cancelled,
            ));
        }
        Ok(())
    }

    /// Bound a single request, keeping transport and reply errors distinct from a deadline.
    async fn request<T>(
        &self,
        operation: &str,
        request: impl Future<Output = zbus::Result<T>>,
    ) -> Result<T, ProtocolError> {
        wait_for_reply(self.request_timeout, operation, request)
            .await?
            .map_err(atspi_error)
    }

    pub async fn available() -> bool {
        Self::connect().await.is_ok()
    }

    async fn proxy<'a>(
        &'a self,
        accessible: &'a AccessibleRef,
        interface: &'a str,
    ) -> Result<Proxy<'a>, ProtocolError> {
        // These proxies are short-lived. Fetch a property directly rather than starting
        // a background `GetAll` that can outlive the request deadline.
        zbus::proxy::Builder::new(&self.connection)
            .destination(accessible.destination.as_str())
            .and_then(|builder| builder.path(accessible.path.as_str()))
            .and_then(|builder| builder.interface(interface))
            .map_err(atspi_error)?
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .map_err(atspi_error)
    }

    async fn children(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<Vec<AccessibleRef>, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let member = "GetChildren";
        let children: Vec<(String, OwnedObjectPath)> =
            self.request(member, proxy.call(member, &())).await?;
        Ok(children
            .into_iter()
            .filter(|(destination, path)| !destination.is_empty() && path.as_str() != "/")
            .map(|(destination, path)| AccessibleRef {
                destination,
                path: path.to_string(),
            })
            .collect())
    }

    async fn string_property(
        &self,
        accessible: &AccessibleRef,
        property: &str,
    ) -> Result<String, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        self.request(property, proxy.get_property(property)).await
    }

    async fn role_name(&self, accessible: &AccessibleRef) -> Result<String, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let member = "GetRoleName";
        self.request(member, proxy.call(member, &())).await
    }

    async fn role_access(&self, accessible: &AccessibleRef) -> RoleAccess {
        let Ok(proxy) = self.proxy(accessible, ACCESSIBLE).await else {
            return RoleAccess::Unclassified;
        };
        let member = "GetRole";
        classify_role(self.request(member, proxy.call(member, &())).await.ok())
    }

    async fn interfaces(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<HashSet<String>, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let member = "GetInterfaces";
        let names: Vec<String> = self.request(member, proxy.call(member, &())).await?;
        Ok(names.into_iter().collect())
    }

    async fn bounds(&self, accessible: &AccessibleRef) -> Option<Rect> {
        let proxy = self.proxy(accessible, COMPONENT).await.ok()?;
        let member = "GetExtents";
        let (x, y, width, height): (i32, i32, i32, i32) = self
            .request(member, proxy.call(member, &(0u32)))
            .await
            .ok()?;
        (width > 0 && height > 0).then_some(Rect {
            x,
            y,
            width,
            height,
        })
    }

    async fn application_pid(&self, accessible: &AccessibleRef) -> Result<u64, ProtocolError> {
        let bus = Proxy::new(
            &self.connection,
            DBUS_DESTINATION,
            DBUS_ROOT,
            DBUS_INTERFACE,
        )
        .await
        .map_err(atspi_error)?;
        let member = "GetConnectionUnixProcessID";
        let connection_pid: u32 = self
            .request(member, bus.call(member, &(accessible.destination.as_str())))
            .await?;
        Ok(u64::from(connection_pid))
    }

    /// The connection PID of `accessible`'s bus owner and that process's executable. Only a
    /// unique connection name (`:1.42`) is attributed: a well-known name can change owner between
    /// requests, so it stays unidentified.
    async fn bus_owner(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<(u64, Option<Executable>), ProtocolError> {
        let pid = self.application_pid(accessible).await?;
        let unique = accessible.destination.starts_with(':');
        Ok((
            pid,
            unique
                .then(|| process_executable(&self.proc_root, pid))
                .flatten(),
        ))
    }

    pub async fn list_roots(
        &self,
        filter_pid: Option<u64>,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        let registry = AccessibleRef {
            destination: REGISTRY_DESTINATION.to_owned(),
            path: REGISTRY_ROOT.to_owned(),
        };
        let applications = self.children(&registry).await?;
        let mut roots = Vec::new();
        for app in applications {
            // A PID-scoped inventory proves absence, so an app it could not read must fail it.
            let (pid, executable) =
                scoped_inventory(filter_pid, self.bus_owner(&app).await, (0, None))?;
            if filter_pid.is_some_and(|wanted| wanted != pid) {
                continue;
            }
            let app_name = self
                .checked_metadata(&app, async || {
                    self.string_property(&app, "Name").await.unwrap_or_default()
                })
                .await
                .unwrap_or_else(|_| PROTECTED_LABEL.to_owned());
            let windows = scoped_inventory(filter_pid, self.children(&app).await, Vec::new())?;
            for window in windows {
                // A window on another connection belongs to a process this entry's owner does
                // not vouch for: it never inherits that identity, so it is unidentified.
                let executable = executable
                    .clone()
                    .filter(|_| window.destination == app.destination);
                let (role, name) = self
                    .checked_metadata(&window, async || {
                        (
                            self.role_name(&window).await.unwrap_or_default(),
                            self.string_property(&window, "Name")
                                .await
                                .unwrap_or_default(),
                        )
                    })
                    .await
                    .unwrap_or_else(|access| {
                        (
                            access.protected_name().to_owned(),
                            PROTECTED_LABEL.to_owned(),
                        )
                    });
                roots.push(RootSnapshot {
                    frame: self.bounds(&window).await,
                    accessible: window,
                    pid,
                    name: if name.is_empty() {
                        app_name.clone()
                    } else {
                        name
                    },
                    app_name: app_name.clone(),
                    executable,
                    wm_class: None,
                    class_candidates: Vec::new(),
                    role,
                    x11_window: None,
                    is_focused: false,
                    is_minimized: false,
                    z_order: None,
                });
            }
        }
        Ok(roots)
    }

    /// The live bus owner of `root`, found by its bus name and object path alone (#1300): one
    /// registry read, then only the window lists of applications on `root`'s own connection,
    /// never another application's metadata. `None` only when every read completed without
    /// listing it; a failed or timed-out read is an error, never absence. The root's own live
    /// name and extents follow, so an X11 pairing ranks against the root as it is now, never
    /// against what an earlier pairing saved; an unreadable one is simply no evidence.
    pub async fn exact_root(
        &self,
        root: &AccessibleRef,
    ) -> Result<Option<LiveRoot>, ProtocolError> {
        let registry = AccessibleRef {
            destination: REGISTRY_DESTINATION.to_owned(),
            path: REGISTRY_ROOT.to_owned(),
        };
        for app in self.children(&registry).await? {
            if app.destination == root.destination && self.children(&app).await?.contains(root) {
                let (pid, executable) = self.bus_owner(root).await?;
                let name = self
                    .checked_metadata(root, async || {
                        self.string_property(root, "Name").await.unwrap_or_default()
                    })
                    .await
                    .unwrap_or_default();
                return Ok(Some(LiveRoot {
                    pid,
                    executable,
                    name,
                    frame: self.bounds(root).await,
                }));
            }
        }
        Ok(None)
    }

    /// Read provider metadata only while the live role is readable before and after the read.
    async fn checked_metadata<T>(
        &self,
        accessible: &AccessibleRef,
        read: impl AsyncFnOnce() -> T,
    ) -> Result<T, RoleAccess> {
        let access = self.role_access(accessible).await;
        let Some(id) = access.readable() else {
            return Err(access);
        };
        let metadata = read().await;
        match self.role_access(accessible).await {
            RoleAccess::Readable(confirmed) if confirmed == id => Ok(metadata),
            RoleAccess::Password => Err(RoleAccess::Password),
            _ => Err(RoleAccess::Unclassified),
        }
    }

    pub async fn snapshot(
        &self,
        root: &RootSnapshot,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Snapshot, ProtocolError> {
        self.snapshot_from(&root.accessible, max_nodes, max_depth)
            .await
    }

    /// Preserve partial observations without mistaking unread nodes for absent nodes.
    pub async fn snapshot_from(
        &self,
        start: &AccessibleRef,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Snapshot, ProtocolError> {
        let mut result = Vec::new();
        let mut incomplete = false;
        let mut root_fields_incomplete = false;
        let mut seen = HashSet::new();
        let mut unread_parents = HashSet::new();
        let mut queue = VecDeque::from([(start.clone(), None, 0usize)]);
        while let Some((accessible, parent, depth)) = queue.pop_front() {
            if !seen.insert(accessible.clone()) {
                continue;
            }
            if result.len() >= max_nodes || depth > max_depth {
                incomplete = true;
                unread_parents.extend(parent);
                continue;
            }
            let mut unread = false;
            let interfaces = field_or_default(self.interfaces(&accessible).await, &mut unread);
            let access = self.role_access(&accessible).await;
            unread |= access == RoleAccess::Unclassified;
            let mut value = String::new();
            let mut fields = match access.readable() {
                Some(id) => {
                    // `wait_for` matches the role name, so a blank or failed one cannot prove absence.
                    let role = self.role_name(&accessible).await.unwrap_or_default();
                    unread |= role.trim().is_empty();
                    NodeFields {
                        readable: Some(id),
                        role,
                        name: field_or_default(
                            self.string_property(&accessible, "Name").await,
                            &mut unread,
                        ),
                        description: field_or_default(
                            self.string_property(&accessible, "Description").await,
                            &mut unread,
                        ),
                    }
                }
                None => NodeFields::protected(access),
            };
            if fields.readable.is_some() && contradicts_readable_role(&fields.role) {
                fields = NodeFields::protected(RoleAccess::Unclassified);
                unread = true;
            }
            if let Some(id) = fields.readable {
                // Text content also needs a confirmed role name; a blank one is already `unread`.
                let result = if interfaces.contains(TEXT) && !fields.role.trim().is_empty() {
                    self.read_checked_text(&accessible, id, &fields.role).await
                } else {
                    self.confirm_role(&accessible, id)
                        .await
                        .map(|()| String::new())
                };
                match result {
                    Err(error) if error.code == ErrorCode::SecureTextUnreadable => {
                        fields = NodeFields::protected(RoleAccess::Unclassified);
                        unread = true;
                    }
                    other => value = field_or_default(other, &mut unread),
                }
            }
            incomplete |= unread;
            if depth == 0 {
                root_fields_incomplete = incomplete;
            }
            let children = self.children(&accessible).await.unwrap_or_else(|_| {
                unread = true;
                Vec::new()
            });
            // A child on another bus connection belongs to another process, which this root's
            // identity never admitted: leave it unread rather than observe it.
            let (children, foreign): (Vec<_>, Vec<_>) = children
                .into_iter()
                .partition(|child| child.destination == start.destination);
            unread |= !foreign.is_empty();
            incomplete |= unread;
            for child in children {
                queue.push_back((child, Some(accessible.clone()), depth + 1));
            }
            result.push(NodeSnapshot {
                reference: String::new(),
                bounds: self.bounds(&accessible).await,
                accessible,
                parent,
                name: fields.name,
                role: fields.role,
                description: fields.description,
                value,
                interfaces,
                is_secure: fields.readable.is_none(),
                depth,
                unread,
            });
        }
        for node in &mut result {
            node.unread |= unread_parents.contains(&node.accessible);
        }
        Ok(Snapshot {
            nodes: result,
            incomplete,
            root_fields_incomplete,
        })
    }

    /// Authorize an explicit text read against the live role, never a cached look: a
    /// readable numeric role plus a nonblank role name that does not contradict it.
    pub async fn read_live_text(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<String, ProtocolError> {
        let id = self
            .role_access(accessible)
            .await
            .readable()
            .ok_or_else(unconfirmed_role)?;
        let role_name = self.role_name(accessible).await.unwrap_or_default();
        if role_name.trim().is_empty() || contradicts_readable_role(&role_name) {
            return Err(unconfirmed_role());
        }
        self.read_checked_text(accessible, id, &role_name).await
    }

    /// Discard the reply unless both live role fields still match the authorizing ones: the
    /// numeric role and the role name.
    async fn read_checked_text(
        &self,
        accessible: &AccessibleRef,
        role: u32,
        role_name: &str,
    ) -> Result<String, ProtocolError> {
        let proxy = self.proxy(accessible, TEXT).await?;
        let member = "GetText";
        let reply = self
            .request(member, proxy.call(member, &(0i32, -1i32)))
            .await;
        self.confirm_role(accessible, role).await?;
        if self.role_name(accessible).await.ok().as_deref() != Some(role_name) {
            return Err(unconfirmed_role());
        }
        reply
    }

    async fn confirm_role(
        &self,
        accessible: &AccessibleRef,
        expected: u32,
    ) -> Result<(), ProtocolError> {
        if self.role_access(accessible).await != RoleAccess::Readable(expected) {
            return Err(unconfirmed_role());
        }
        Ok(())
    }

    pub async fn press(&self, node: &NodeSnapshot) -> Result<bool, ProtocolError> {
        if !node.interfaces.contains(ACTION) {
            return Err(ProtocolError::new(
                "Target does not expose the AT-SPI Action interface",
                ErrorCode::CapabilityDeferred,
            ));
        }
        let proxy = self.proxy(&node.accessible, ACTION).await?;
        let action_count = bounded_action_count(
            wait_for_reply(
                self.request_timeout,
                "NActions",
                proxy.get_property::<i32>("NActions"),
            )
            .await?
            .ok(),
        )?;
        let mut names = Vec::new();
        if action_count > 1 {
            let member = "GetName";
            names.reserve(action_count);
            for index in 0..action_count {
                let name: String = wait_for_reply(
                    self.request_timeout,
                    member,
                    proxy.call(member, &(index as i32)),
                )
                .await?
                .unwrap_or_default();
                names.push(name);
            }
        }
        let Some(action_index) = selected_action_index(action_count, &names) else {
            return Ok(false);
        };
        self.admit_mutation()?;
        let member = "DoAction";
        self.request(member, proxy.call(member, &(action_index)))
            .await
    }

    pub async fn set_text(&self, node: &NodeSnapshot, text: &str) -> Result<bool, ProtocolError> {
        if !node.interfaces.contains(EDITABLE_TEXT) {
            return Err(ProtocolError::new(
                "Target does not expose the AT-SPI EditableText interface",
                ErrorCode::CapabilityDeferred,
            ));
        }
        let proxy = self.proxy(&node.accessible, EDITABLE_TEXT).await?;
        self.admit_mutation()?;
        let member = "SetTextContents";
        self.request(member, proxy.call(member, &(text))).await
    }
}

/// The executable's block-only aliases, then the non-empty names of every ambiguous class
/// candidate, each once.
fn block_aliases(root: &RootSnapshot) -> Vec<&str> {
    let mut aliases = root
        .executable
        .as_ref()
        .map(Executable::block_aliases)
        .unwrap_or_default();
    for (instance, class) in &root.class_candidates {
        for name in [instance.as_str(), class.as_str()] {
            if !name.is_empty() && !aliases.contains(&name) {
                aliases.push(name);
            }
        }
    }
    aliases
}

pub fn root_json(reference: &str, root: &RootSnapshot, z_order: usize) -> Value {
    let kind = if root.role.to_lowercase().contains("dialog") {
        "dialog"
    } else {
        "window"
    };
    let frame = root
        .frame
        .as_ref()
        .map(|r| json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height}))
        .unwrap_or_else(|| json!({"x":0,"y":0,"width":0,"height":0}));
    json!({
        "kind": kind,
        "rootRef": reference,
        "windowRef": reference,
        "ref": reference,
        "windowId": root.x11_window,
        "title": root.name,
        "pid": root.pid,
        "appName": root.app_name,
        // The accessible app name is presentation only; policy uses the executable (#1180).
        "appId": root.executable.as_ref().map(|executable| &executable.name),
        "processName": root.executable.as_ref().map(|executable| &executable.name),
        // Block-only names: they can refuse a root, never admit one. An ambiguous X11 pairing
        // reports every tied window's class here, so a blocked sibling blocks conservatively.
        "blockAliases": block_aliases(root),
        "role": root.role,
        "subrole": "",
        "zOrder": root.z_order.unwrap_or(z_order),
        "framePoints": frame,
        "bounds": frame,
        "scaleFactor": 1.0,
        "isFocused": root.is_focused,
        "isMain": root.is_focused || z_order == 0,
        "isMinimized": root.is_minimized,
        "isOnscreen": true,
        "isModal": kind == "dialog",
        "metadata": {
            "backend":"at-spi2",
            "busName":root.accessible.destination,
            "objectPath":root.accessible.path,
            "wmClass":root.wm_class.as_ref().map(|(instance, class)| json!({"instance":instance,"class":class})),
        },
        "isBrowser": false,
        "browserFamily": Value::Null
    })
}

pub fn outline_json(root: &RootSnapshot, nodes: &[NodeSnapshot], max_nodes: usize) -> Value {
    let mut descendants: HashMap<AccessibleRef, Vec<Value>> = HashMap::new();
    let mut roots = Vec::new();
    for node in nodes.iter().rev() {
        let rect = node
            .bounds
            .as_ref()
            .map(|r| {
                let origin_x = root.frame.as_ref().map(|f| f.x).unwrap_or(0);
                let origin_y = root.frame.as_ref().map(|f| f.y).unwrap_or(0);
                json!({"x":relative_coordinate(r.x, origin_x),"y":relative_coordinate(r.y, origin_y),"w":r.width,"h":r.height})
            })
            .unwrap_or_else(|| json!({"x":0,"y":0,"w":0,"h":0}));
        let can_press = node.interfaces.contains(ACTION);
        let can_set_value = node.interfaces.contains(EDITABLE_TEXT);
        let mut actions = Vec::new();
        if can_press {
            actions.push("press");
        }
        if can_set_value {
            actions.push("setValue");
        }
        let mut children = descendants.remove(&node.accessible).unwrap_or_default();
        children.reverse();
        let value = json!({
            "ref": node.reference,
            "role": node.role,
            "subrole": "",
            "identifier": node.accessible.path,
            "title": node.name,
            "description": node.description,
            "value": if node.is_secure { "" } else { &node.value },
            "actions": actions,
            "canPress": can_press,
            "canFocus": false,
            "canSetValue": can_set_value,
            "canScroll": false,
            "canIncrement": false,
            "canDecrement": false,
            "isTextInput": can_set_value,
            "rect": rect,
            "focused": false,
            "offscreen": node.bounds.is_none(),
            "pictureOnly": false,
            "truncated": node.unread || (nodes.len() >= max_nodes && node.depth == 0),
            "text": if node.value.is_empty() || node.is_secure { json!([]) } else {
                json!([{"string":node.value,"confidence":1.0,"rect":rect}])
            },
            "children": children
        });
        if let Some(parent) = &node.parent {
            descendants.entry(parent.clone()).or_default().push(value);
        } else {
            roots.push(value);
        }
    }
    roots.reverse();
    if roots.is_empty() {
        json!({"role":"window","title":"","children":[],"truncated":false})
    } else {
        let mut root = roots.remove(0);
        if !roots.is_empty() {
            root["children"]
                .as_array_mut()
                .expect("children array")
                .extend(roots);
        }
        root
    }
}

fn normalized_action_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn activation_action_index(names: &[String]) -> usize {
    const PRIORITY: [&str; 5] = ["activate", "click", "press", "invoke", "open"];
    PRIORITY
        .iter()
        .find_map(|wanted| {
            names
                .iter()
                .position(|name| normalized_action_name(name) == *wanted)
        })
        .unwrap_or(0)
}

fn selected_action_index(action_count: usize, names: &[String]) -> Option<i32> {
    match action_count {
        0 => None,
        1 => Some(0),
        _ => Some(activation_action_index(names) as i32),
    }
}

fn bounded_action_count(raw_count: Option<i32>) -> Result<usize, ProtocolError> {
    let count = raw_count.unwrap_or(0);
    if count <= 1 {
        return Ok(count.max(0) as usize);
    }
    let count = usize::try_from(count).map_err(|_| {
        ProtocolError::new(
            "AT-SPI action count is invalid",
            ErrorCode::CapabilityDeferred,
        )
    })?;
    if count > MAX_ATSPI_ACTIONS {
        return Err(ProtocolError::new(
            format!(
                "AT-SPI target exposes {count} actions; maximum supported is {MAX_ATSPI_ACTIONS}"
            ),
            ErrorCode::CapabilityDeferred,
        ));
    }
    Ok(count)
}

fn relative_coordinate(value: i32, origin: i32) -> i32 {
    value.saturating_sub(origin)
}

/// Bound the wait without changing how each caller handles a reply error.
async fn wait_for_reply<T>(
    timeout: Duration,
    operation: &str,
    request: impl Future<Output = T>,
) -> Result<T, ProtocolError> {
    tokio::time::timeout(timeout, request).await.map_err(|_| {
        ProtocolError::new(format!("AT-SPI2 {operation} timed out"), ErrorCode::Timeout)
    })
}

/// Resolve and validate the accessibility bus address advertised on the session bus.
async fn accessibility_bus_address(
    session: &Connection,
    timeout: Duration,
) -> Result<Address, ProtocolError> {
    let bus = Proxy::new(session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
        .await
        .map_err(unavailable)?;
    let member = "GetAddress";
    let address: String = wait_for_reply(timeout, member, bus.call(member, &()))
        .await?
        .map_err(unavailable)?;
    address.parse().map_err(unavailable)
}

/// Keep a best-effort unscoped inventory, but fail a PID-scoped one that timed out: it would prove absence.
fn scoped_inventory<T>(
    filter_pid: Option<u64>,
    result: Result<T, ProtocolError>,
    fallback: T,
) -> Result<T, ProtocolError> {
    match result {
        Err(error) if filter_pid.is_some() && error.code == ErrorCode::Timeout => Err(error),
        result => Ok(result.unwrap_or(fallback)),
    }
}

/// The provider fields of one snapshot node, or fixed labels once its role is protected.
struct NodeFields {
    /// The role ID authorizing provider reads; `None` once the node is protected.
    readable: Option<u32>,
    role: String,
    name: String,
    description: String,
}

impl NodeFields {
    /// The single transition to a protected node: no role authorizes a read and no provider
    /// string survives.
    fn protected(access: RoleAccess) -> Self {
        Self {
            readable: None,
            role: access.protected_name().to_owned(),
            name: PROTECTED_LABEL.to_owned(),
            description: String::new(),
        }
    }
}

/// Whether a live `GetRole` reply permits reading provider names, descriptions and text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoleAccess {
    /// A recognized, non-password role ID.
    Readable(u32),
    /// The password text role.
    Password,
    /// An unavailable, invalid, unknown, extended or unrecognized role.
    Unclassified,
}

impl RoleAccess {
    /// Return the role ID that authorizes a read, if any.
    fn readable(self) -> Option<u32> {
        match self {
            Self::Readable(id) => Some(id),
            Self::Password | Self::Unclassified => None,
        }
    }

    /// Use a fixed role label rather than provider strings for a protected node.
    fn protected_name(self) -> &'static str {
        match self {
            Self::Password => "password text",
            Self::Readable(_) | Self::Unclassified => "unknown",
        }
    }
}

/// The single readable-role rule for root discovery, snapshots and explicit reads.
fn classify_role(role_id: Option<u32>) -> RoleAccess {
    match role_id {
        Some(PASSWORD_TEXT_ROLE) => RoleAccess::Password,
        Some(id @ (1..=66 | 68..=69 | 71..=130)) => RoleAccess::Readable(id),
        _ => RoleAccess::Unclassified,
    }
}

/// Whether a role name contradicts a readable numeric role, e.g. a literal `unknown` (#1189).
fn contradicts_readable_role(role_name: &str) -> bool {
    let normalized = role_name.trim().to_lowercase();
    PROTECTED_ROLE_NAMES.contains(&normalized.as_str())
}

/// The executable of `pid` under `proc_root`, or `None` when it cannot be attributed: PID 0,
/// an unreadable or non-UTF-8 `exe` link, a relative target, or a shared bus proxy.
/// A ` (deleted)` link suffix is ambiguous (a replaced binary, or a file literally named so),
/// so the identity drops it and the literal basename stays a block-only alias.
pub fn process_executable(proc_root: &Path, pid: u64) -> Option<Executable> {
    if pid == 0 {
        return None;
    }
    let target = std::fs::read_link(proc_root.join(pid.to_string()).join("exe")).ok()?;
    let link_name = target.to_str()?.strip_prefix('/')?.rsplit('/').next()?;
    let name = link_name.strip_suffix(" (deleted)").unwrap_or(link_name);
    (!name.is_empty() && !BUS_PROXY_EXECUTABLES.contains(&name)).then(|| Executable {
        name: name.to_owned(),
        link_name: link_name.to_owned(),
    })
}

fn unconfirmed_role() -> ProtocolError {
    ProtocolError::new(
        "Cannot confirm that the live accessibility role permits reading text",
        ErrorCode::SecureTextUnreadable,
    )
}

/// Retain optional field defaults, but do not use a missing timed-out field to prove absence.
fn field_or_default<T: Default>(result: Result<T, ProtocolError>, incomplete: &mut bool) -> T {
    result.unwrap_or_else(|error| {
        *incomplete |= error.code == ErrorCode::Timeout;
        T::default()
    })
}

fn unavailable(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(
        format!("AT-SPI2 is unavailable: {error}"),
        ErrorCode::CapabilityDeferred,
    )
}

fn atspi_error(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(
        format!("AT-SPI2 request failed: {error}"),
        ErrorCode::InternalError,
    )
}

// Keep the shared test module here so `lib.rs` remains a declaration-only
// module that the native coverage accountant can validate without an LLVM map.
#[cfg(test)]
#[path = "tests.rs"]
pub(crate) mod test_peer;

#[cfg(test)]
mod tests {
    use super::test_peer::{with_peer, StalledReply};
    use super::*;
    use std::{
        future::pending,
        sync::{Arc, Mutex},
    };
    const STALLED_REQUEST_TIMEOUT: Duration = Duration::from_millis(250);

    const FIXTURE_REGISTRY_ROOT: &str = "/org/a11y/atspi/accessible/root";

    const FIXTURE_DBUS_ROOT: &str = "/org/freedesktop/DBus";

    fn peer_client(connection: Connection) -> AtspiClient {
        AtspiClient::from_connection(connection, REQUEST_TIMEOUT)
    }

    #[test]
    fn activation_action_selection_prefers_semantics_over_index_zero() {
        let row = ["expand or contract", "edit", "activate"].map(str::to_owned);
        assert_eq!(activation_action_index(&row), 2);
        let mixed = ["open", "press", "click"].map(str::to_owned);
        assert_eq!(activation_action_index(&mixed), 2);
        let unsupported = ["expand or contract", "edit"].map(str::to_owned);
        assert_eq!(activation_action_index(&unsupported), 0);
        assert_eq!(activation_action_index(&["  InVoKe  ".into()]), 0);
    }

    #[test]
    fn action_count_and_dispatch_boundaries_are_explicit() {
        assert_eq!(bounded_action_count(Some(0)).unwrap(), 0);
        assert_eq!(selected_action_index(0, &[]), None);
        assert_eq!(bounded_action_count(Some(1)).unwrap(), 1);
        assert_eq!(selected_action_index(1, &[]), Some(0));

        let mut names = vec!["edit".to_owned(); 64];
        names[63] = "activate".to_owned();
        assert_eq!(bounded_action_count(Some(64)).unwrap(), 64);
        assert_eq!(selected_action_index(64, &names), Some(63));
        assert!(bounded_action_count(Some(65)).is_err());
        assert!(bounded_action_count(Some(i32::MAX)).is_err());
    }

    #[test]
    fn relative_coordinates_saturate_instead_of_overflowing() {
        assert_eq!(relative_coordinate(i32::MIN, i32::MAX), i32::MIN);
        assert_eq!(relative_coordinate(i32::MAX, i32::MIN), i32::MAX);
        assert_eq!(relative_coordinate(355, 100), 255);
    }

    struct MockBus;

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl MockBus {
        #[zbus(name = "GetConnectionUnixProcessID")]
        fn get_connection_unix_process_id(&self, name: &str) -> u32 {
            assert_eq!(name, ":1.42");
            25361
        }
    }

    struct MockApplication;

    #[zbus::interface(name = "org.a11y.atspi.Application")]
    impl MockApplication {
        #[zbus(property)]
        fn id(&self) -> i32 {
            8
        }
    }

    #[tokio::test]
    async fn application_pid_uses_only_accessibility_bus_process_id() {
        with_peer(
            |server| {
                server
                    .serve_at(DBUS_ROOT, MockBus)?
                    .serve_at(REGISTRY_ROOT, MockApplication)
            },
            async |connection| {
                let client = peer_client(connection);
                let app = AccessibleRef {
                    destination: ":1.42".into(),
                    path: REGISTRY_ROOT.into(),
                };
                let application = client
                    .proxy(&app, "org.a11y.atspi.Application")
                    .await
                    .unwrap();
                assert_eq!(application.get_property::<i32>("Id").await.unwrap(), 8);
                assert_eq!(client.application_pid(&app).await.unwrap(), 25361);
            },
        )
        .await;
    }

    struct MockAccessibilityBus(&'static str);

    #[zbus::interface(name = "org.a11y.Bus")]
    impl MockAccessibilityBus {
        fn get_address(&self) -> &str {
            self.0
        }
    }

    /// Drive address discovery over a private peer connection, without a session daemon.
    async fn discover_from_peer(reply: &'static str) -> Result<Address, ProtocolError> {
        with_peer(
            |server| server.serve_at("/org/a11y/bus", MockAccessibilityBus(reply)),
            async |session| accessibility_bus_address(&session, REQUEST_TIMEOUT).await,
        )
        .await
    }

    #[tokio::test]
    async fn discovers_accessibility_address_via_get_address_method() {
        let advertised = "unix:path=/fixture/atspi";
        let address = discover_from_peer(advertised).await.unwrap();
        assert_eq!(address.to_string(), advertised);
    }

    #[tokio::test]
    async fn defers_capability_when_accessibility_address_is_invalid() {
        let error = discover_from_peer("not a bus address").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::CapabilityDeferred);
        assert!(error.message.starts_with("AT-SPI2 is unavailable: "));
    }

    struct StalledAccessibilityBus(StalledReply);

    #[zbus::interface(name = "org.a11y.Bus")]
    impl StalledAccessibilityBus {
        async fn get_address(&self) -> String {
            self.0.wait().await
        }
    }

    #[tokio::test]
    async fn reports_timeout_when_address_discovery_never_replies() {
        let (stall, mut requests) = StalledReply::new();
        with_peer(
            |server| server.serve_at("/org/a11y/bus", StalledAccessibilityBus(stall)),
            async |session| {
                let (result, received) = tokio::join!(
                    accessibility_bus_address(&session, STALLED_REQUEST_TIMEOUT),
                    requests.recv(),
                );
                assert_eq!(received, Some(()));
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::Timeout);
                assert_eq!(error.message, "AT-SPI2 GetAddress timed out");
            },
        )
        .await;
    }

    /// Accessible properties and edges for a small, cyclic AT-SPI tree.
    struct TreeNode {
        name: &'static str,
        role: &'static str,
        children: &'static [(&'static str, &'static str)],
        has_text: bool,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl TreeNode {
        #[zbus(property)]
        fn name(&self) -> &str {
            self.name
        }

        #[zbus(property)]
        fn description(&self) -> &str {
            "fixture description"
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            self.children
                .iter()
                .map(|&(destination, path)| (destination, OwnedObjectPath::try_from(path).unwrap()))
                .collect()
        }

        fn get_role_name(&self) -> &str {
            self.role
        }

        fn get_role(&self) -> u32 {
            match self.role {
                "desktop" => 14,
                "dialog" => 16,
                "frame" => 23,
                "label" => 29,
                "PaSsWoRd TeXt" => 40,
                "application" => 75,
                other => panic!("Missing fixture role ID for {other}"),
            }
        }

        fn get_interfaces(&self) -> Vec<&str> {
            if self.has_text {
                vec![TEXT]
            } else {
                vec![]
            }
        }
    }

    struct WindowExtents {
        width: i32,
        coordinate_requests: Arc<Mutex<Vec<u32>>>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Component")]
    impl WindowExtents {
        fn get_extents(&self, coordinate_type: u32) -> (i32, i32, i32, i32) {
            assert_eq!(coordinate_type, 0, "use screen coordinates");
            self.coordinate_requests
                .lock()
                .unwrap()
                .push(coordinate_type);
            (-20, 40, self.width, 480)
        }
    }

    #[tokio::test]
    async fn lists_atspi_roots_with_pid_filter_title_fallback_and_screen_bounds() {
        const DESTINATION: &str = ":1.42";
        const APP: &str = "/app";
        const WINDOW: &str = "/app/window";
        const DIALOG: &str = "/app/dialog";
        let dialog_coordinate_requests = Arc::new(Mutex::new(Vec::new()));

        with_peer(
            |server| {
                let node = |name, role, children: &'static [(&str, &str)]| TreeNode {
                    name,
                    role,
                    children,
                    has_text: false,
                };
                server
                    .serve_at(FIXTURE_DBUS_ROOT, MockBus)?
                    .serve_at(
                        FIXTURE_REGISTRY_ROOT,
                        node("Registry", "desktop", &[(DESTINATION, APP)]),
                    )?
                    .serve_at(
                        APP,
                        node(
                            "Editor",
                            "application",
                            &[(DESTINATION, WINDOW), (DESTINATION, DIALOG)],
                        ),
                    )?
                    .serve_at(WINDOW, node("Notes", "frame", &[]))?
                    .serve_at(
                        WINDOW,
                        WindowExtents {
                            width: 640,
                            coordinate_requests: Arc::default(),
                        },
                    )?
                    .serve_at(DIALOG, node("", "dialog", &[]))?
                    .serve_at(
                        DIALOG,
                        WindowExtents {
                            width: 0,
                            coordinate_requests: Arc::clone(&dialog_coordinate_requests),
                        },
                    )
            },
            async |connection| {
                let proc = ProcFixture::new(&[(25361, "/usr/bin/fixture-editor")]);
                let client = peer_client(connection).with_proc_root(&proc.0);
                let roots = client.list_roots(None).await.unwrap();
                let [window, dialog] = roots.as_slice() else {
                    panic!(
                        "expected one window and one dialog, got {} roots",
                        roots.len()
                    );
                };
                assert_eq!(window.accessible.path, WINDOW);
                assert_eq!(window.accessible.destination, DESTINATION);
                assert_eq!(window.pid, 25361);
                assert_eq!(window.name, "Notes");
                assert_eq!(window.app_name, "Editor");
                // Identity comes from the bus PID's executable, never the accessible Name.
                assert_eq!(executable_name(window), Some("fixture-editor"));
                assert_eq!(executable_name(dialog), Some("fixture-editor"));
                assert_eq!(root_json("@w1", window, 0)["appId"], "fixture-editor");
                assert_eq!(window.role, "frame");
                assert_eq!(
                    window.frame,
                    Some(Rect {
                        x: -20,
                        y: 40,
                        width: 640,
                        height: 480
                    })
                );
                assert_eq!(dialog.accessible.path, DIALOG);
                assert_eq!(dialog.name, "Editor");
                assert_eq!(dialog.role, "dialog");
                assert_eq!(*dialog_coordinate_requests.lock().unwrap(), [0]);
                assert_eq!(dialog.frame, None);

                let matching = client.list_roots(Some(25361)).await.unwrap();
                assert_eq!(
                    matching
                        .iter()
                        .map(|root| root.accessible.path.as_str())
                        .collect::<Vec<_>>(),
                    [WINDOW, DIALOG]
                );
                assert!(client.list_roots(Some(25362)).await.unwrap().is_empty());

                let unattributed = ProcFixture::new(&[]);
                let client = client.with_proc_root(&unattributed.0);
                let roots = client.list_roots(None).await.unwrap();
                assert_eq!(roots.len(), 2);
                assert!(roots.iter().all(|root| root.executable.is_none()));
            },
        )
        .await;
    }

    /// Reply once with a readable role, then persistently with `after`.
    struct FlippingNode {
        name: &'static str,
        readable: u32,
        after: u32,
        role_requests: std::sync::atomic::AtomicUsize,
        children: &'static [(&'static str, &'static str)],
    }

    impl FlippingNode {
        fn new(
            name: &'static str,
            readable: u32,
            after: u32,
            children: &'static [(&'static str, &'static str)],
        ) -> Self {
            Self {
                name,
                readable,
                after,
                role_requests: Default::default(),
                children,
            }
        }
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl FlippingNode {
        #[zbus(property)]
        fn name(&self) -> &str {
            self.name
        }

        fn get_children(&self) -> Vec<(&str, OwnedObjectPath)> {
            self.children
                .iter()
                .map(|&(destination, path)| (destination, OwnedObjectPath::try_from(path).unwrap()))
                .collect()
        }

        fn get_role_name(&self) -> &str {
            "frame"
        }

        fn get_role(&self) -> u32 {
            let order = std::sync::atomic::Ordering::SeqCst;
            if self.role_requests.fetch_add(1, order) == 0 {
                self.readable
            } else {
                self.after
            }
        }
    }

    #[tokio::test]
    async fn list_roots_discards_metadata_when_the_role_turns_protected_during_the_read() {
        const DESTINATION: &str = ":1.42";
        const APP: &str = "/app";
        const SECRET: &str = "private fixture title";
        with_peer(
            |server| {
                server
                    .serve_at(FIXTURE_DBUS_ROOT, MockBus)?
                    .serve_at(
                        FIXTURE_REGISTRY_ROOT,
                        TreeNode {
                            name: "Registry",
                            role: "desktop",
                            children: &[(DESTINATION, APP)],
                            has_text: false,
                        },
                    )?
                    .serve_at(
                        APP,
                        FlippingNode::new(
                            SECRET,
                            75,
                            PASSWORD_TEXT_ROLE,
                            &[
                                (DESTINATION, "/app/unknown"),
                                (DESTINATION, "/app/password"),
                                (DESTINATION, "/app/changed"),
                            ],
                        ),
                    )?
                    .serve_at("/app/unknown", FlippingNode::new(SECRET, 23, 67, &[]))?
                    .serve_at(
                        "/app/password",
                        FlippingNode::new(SECRET, 23, PASSWORD_TEXT_ROLE, &[]),
                    )?
                    .serve_at("/app/changed", FlippingNode::new(SECRET, 23, 16, &[]))
            },
            async |connection| {
                let roots = peer_client(connection).list_roots(None).await.unwrap();
                let roles = roots
                    .iter()
                    .map(|root| root.role.as_str())
                    .collect::<Vec<_>>();
                assert_eq!(roles, ["unknown", "password text", "unknown"]);
                for (index, root) in roots.iter().enumerate() {
                    assert_eq!(root.name, PROTECTED_LABEL);
                    assert_eq!(root.app_name, PROTECTED_LABEL);
                    assert!(!root_json("@w1", root, index).to_string().contains(SECRET));
                }
            },
        )
        .await;
    }

    struct DisconnectingRegistry;

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl DisconnectingRegistry {
        async fn get_children(
            &self,
            #[zbus(connection)] connection: &Connection,
        ) -> Vec<(String, OwnedObjectPath)> {
            connection.clone().close().await.unwrap();
            pending().await
        }
    }

    #[tokio::test]
    async fn list_roots_reports_registry_disconnect() {
        with_peer(
            |server| server.serve_at(FIXTURE_REGISTRY_ROOT, DisconnectingRegistry),
            async |connection| {
                let error = peer_client(connection).list_roots(None).await.unwrap_err();
                assert_eq!(error.code, ErrorCode::InternalError);
                assert_eq!(
                    error.message,
                    "AT-SPI2 request failed: I/O error: failed to read from socket"
                );
            },
        )
        .await;
    }

    struct MalformedRegistry;

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl MalformedRegistry {
        fn get_children(&self) -> u32 {
            42
        }
    }

    #[tokio::test]
    async fn list_roots_reports_malformed_registry_reply() {
        with_peer(
            |server| server.serve_at(FIXTURE_REGISTRY_ROOT, MalformedRegistry),
            async |connection| {
                let error = peer_client(connection).list_roots(None).await.unwrap_err();
                assert_eq!(error.code, ErrorCode::InternalError);
                assert_eq!(
                    error.message,
                    "AT-SPI2 request failed: Signature mismatch: got `u`, expected `a(so)`"
                );
            },
        )
        .await;
    }

    struct StalledRegistry(StalledReply);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl StalledRegistry {
        async fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
            self.0.wait().await
        }
    }

    #[tokio::test]
    async fn list_roots_reports_timeout_when_registry_never_replies() {
        let (stall, mut requests) = StalledReply::new();
        with_peer(
            |server| server.serve_at(FIXTURE_REGISTRY_ROOT, StalledRegistry(stall)),
            async |connection| {
                let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT);
                let (result, received) = tokio::join!(client.list_roots(None), requests.recv());
                assert_eq!(received, Some(()));
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::Timeout);
                assert_eq!(error.code.to_string(), "timeout");
                assert_eq!(error.message, "AT-SPI2 GetChildren timed out");
            },
        )
        .await;
    }

    /// An application whose window inventory never replies.
    struct StalledApplication(StalledReply);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl StalledApplication {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Editor"
        }

        async fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
            self.0.wait().await
        }
    }

    /// A bus whose connection PID lookup never replies.
    struct StalledBus(StalledReply);

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl StalledBus {
        #[zbus(name = "GetConnectionUnixProcessID")]
        async fn get_connection_unix_process_id(&self, _name: &str) -> u32 {
            self.0.wait().await
        }
    }

    #[tokio::test]
    async fn partial_inventory_cannot_verify_absence() {
        for stalled_pid in [false, true] {
            let (stall, mut requests) = StalledReply::new();
            with_peer(
                |server| {
                    let registry = TreeNode {
                        name: "Registry",
                        role: "desktop",
                        children: &[(":1.42", "/app")],
                        has_text: false,
                    };
                    let server = server.serve_at(FIXTURE_REGISTRY_ROOT, registry)?;
                    if stalled_pid {
                        server.serve_at(FIXTURE_DBUS_ROOT, StalledBus(stall))
                    } else {
                        server
                            .serve_at(FIXTURE_DBUS_ROOT, MockBus)?
                            .serve_at("/app", StalledApplication(stall))
                    }
                },
                async |connection| {
                    let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT);
                    // An unscoped listing stays best-effort.
                    assert!(client.list_roots(None).await.unwrap().is_empty());
                    assert_eq!(requests.try_recv(), Ok(()));
                    // A PID-scoped probe must not read a stalled inventory as an empty one.
                    let error = client.list_roots(Some(25361)).await.unwrap_err();
                    assert_eq!(requests.try_recv(), Ok(()));
                    assert_eq!(error.code, ErrorCode::Timeout);
                    let member = if stalled_pid {
                        "GetConnectionUnixProcessID"
                    } else {
                        "GetChildren"
                    };
                    assert_eq!(error.message, format!("AT-SPI2 {member} timed out"));
                    if !stalled_pid {
                        // Another app's PID is read in full, so its absence is still provable.
                        assert!(client.list_roots(Some(25362)).await.unwrap().is_empty());
                    }
                },
            )
            .await;
        }
    }

    struct StalledAction(StalledReply);

    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl StalledAction {
        #[zbus(property, name = "NActions")]
        async fn n_actions(&self) -> i32 {
            self.0.wait().await
        }
    }

    #[tokio::test]
    async fn press_reports_timeout_when_action_count_never_replies() {
        let (stall, mut requests) = StalledReply::new();
        with_peer(
            |server| server.serve_at("/node", StalledAction(stall)),
            async |connection| {
                let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT);
                let mut node = NodeSnapshot::minimal(AccessibleRef {
                    destination: ":1.42".into(),
                    path: "/node".into(),
                });
                node.interfaces.insert(ACTION.into());
                let (result, received) = tokio::join!(client.press(&node), requests.recv());
                assert_eq!(received, Some(()));
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::Timeout);
                assert_eq!(error.message, "AT-SPI2 NActions timed out");
            },
        )
        .await;
    }

    /// Record calls so a password read fails even if its result is subsequently discarded.
    #[derive(Clone, Default)]
    struct TreeText(std::sync::Arc<std::sync::Mutex<Vec<(i32, i32)>>>);

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl TreeText {
        fn get_text(&self, start: i32, end: i32) -> &str {
            self.0.lock().unwrap().push((start, end));
            "fixture text"
        }
    }

    #[tokio::test]
    async fn snapshots_bound_tree_traversal_and_never_read_password_text() {
        const DESTINATION: &str = ":1.42";
        const ROOT: &str = "/window";
        const PASSWORD: &str = "/window/password";
        const LABEL: &str = "/window/label";
        let password_text = TreeText::default();
        let label_text = TreeText::default();
        with_peer(
            |server| {
                server
                    .serve_at(
                        ROOT,
                        TreeNode {
                            name: "frame",
                            role: "frame",
                            children: &[
                                (DESTINATION, PASSWORD),
                                ("", LABEL),
                                (DESTINATION, "/"),
                                (DESTINATION, LABEL),
                            ],
                            has_text: false,
                        },
                    )?
                    .serve_at(
                        PASSWORD,
                        TreeNode {
                            name: "PaSsWoRd TeXt",
                            role: "PaSsWoRd TeXt",
                            children: &[],
                            has_text: true,
                        },
                    )?
                    .serve_at(PASSWORD, password_text.clone())?
                    .serve_at(
                        LABEL,
                        TreeNode {
                            name: "label",
                            role: "label",
                            children: &[(DESTINATION, ROOT)],
                            has_text: true,
                        },
                    )?
                    .serve_at(LABEL, label_text.clone())
            },
            async |connection| {
                let client = peer_client(connection);
                let root = AccessibleRef {
                    destination: DESTINATION.into(),
                    path: ROOT.into(),
                };

                let Snapshot {
                    nodes, incomplete, ..
                } = client.snapshot_from(&root, 10, 10).await.unwrap();
                assert!(!incomplete);
                assert!(nodes.iter().all(|node| !node.unread));
                assert_eq!(nodes.len(), 3);
                assert_eq!(nodes[0].accessible, root);
                assert_eq!(nodes[0].parent, None);
                assert_eq!(nodes[0].depth, 0);
                assert_eq!(nodes[0].name, "frame");
                assert_eq!(nodes[0].description, "fixture description");
                assert_eq!(nodes[0].bounds, None);
                assert_eq!(nodes[1].accessible.path, PASSWORD);
                assert_eq!(nodes[2].accessible.path, LABEL);
                for child in &nodes[1..] {
                    assert_eq!(child.parent.as_ref(), Some(&root));
                    assert_eq!(child.depth, 1);
                    assert!(child.interfaces.contains(TEXT));
                }
                assert!(nodes[1].is_secure);
                assert!(nodes[1].value.is_empty());
                assert!(!nodes[2].is_secure);
                assert_eq!(nodes[2].value, "fixture text");

                let depth_limited = client.snapshot_from(&root, 10, 0).await.unwrap();
                assert!(depth_limited.incomplete);
                assert_eq!(depth_limited.nodes.len(), 1);
                assert_eq!(depth_limited.nodes[0].accessible, root);
                assert!(
                    depth_limited.nodes[0].unread,
                    "unread children mark the parent"
                );
                let node_limited = client.snapshot_from(&root, 2, 10).await.unwrap();
                assert!(node_limited.incomplete);
                assert_eq!(node_limited.nodes.len(), 2);
                assert!(node_limited.nodes[0].unread);
                assert_eq!(node_limited.nodes[1].accessible.path, PASSWORD);
                assert!(!node_limited.nodes[1].unread);
                assert!(password_text.0.lock().unwrap().is_empty());
                assert_eq!(*label_text.0.lock().unwrap(), [(0, -1)]);
            },
        )
        .await;
    }

    #[test]
    fn root_shape_has_cross_platform_aliases() {
        let root = RootSnapshot {
            accessible: AccessibleRef {
                destination: ":1.2".into(),
                path: "/window".into(),
            },
            pid: 42,
            name: "Editor".into(),
            app_name: "Text Editor".into(),
            executable: Some(Executable {
                name: "fixture-editor".into(),
                link_name: "fixture-editor".into(),
            }),
            wm_class: Some(("fixture".into(), "Fixture".into())),
            class_candidates: Vec::new(),
            role: "frame".into(),
            frame: Some(Rect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            }),
            x11_window: Some(99),
            is_focused: true,
            is_minimized: false,
            z_order: Some(0),
        };
        let value = root_json("@w1", &root, 0);
        assert_eq!(value["rootRef"], "@w1");
        assert_eq!(value["windowRef"], "@w1");
        assert_eq!(value["windowId"], 99);
        assert_eq!(value["metadata"]["backend"], "at-spi2");
        assert_eq!(value["title"], "Editor");
        assert_eq!(value["appName"], "Text Editor");
        assert_eq!(value["appId"], "fixture-editor");
        assert_eq!(value["processName"], "fixture-editor");
        assert_eq!(value["blockAliases"], json!([]));
        assert_eq!(
            value["metadata"]["wmClass"],
            json!({"instance":"fixture","class":"Fixture"})
        );

        // A ` (deleted)` link reports the stripped name and keeps the literal one as a block alias.
        let mut replaced = root.clone();
        replaced.executable = Some(Executable {
            name: "editor".into(),
            link_name: "editor (deleted)".into(),
        });
        let replaced = root_json("@w3", &replaced, 0);
        assert_eq!(replaced["appId"], "editor");
        assert_eq!(replaced["blockAliases"], json!(["editor (deleted)"]));

        let mut wayland_root = root;
        wayland_root.x11_window = None;
        wayland_root.executable = None;
        wayland_root.wm_class = None;
        let wayland = root_json("@w2", &wayland_root, 0);
        assert!(wayland["windowId"].is_null());
        // An unattributed root has no identity: never the accessible app name.
        assert!(wayland["appId"].is_null());
        assert!(wayland["processName"].is_null());
        assert_eq!(wayland["blockAliases"], json!([]));
        assert!(wayland["metadata"]["wmClass"].is_null());
    }

    fn executable_name(root: &RootSnapshot) -> Option<&str> {
        root.executable
            .as_ref()
            .map(|executable| executable.name.as_str())
    }

    /// A bus daemon with two application connections and one well-known name.
    struct OwnerBus;

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl OwnerBus {
        #[zbus(name = "GetConnectionUnixProcessID")]
        fn get_connection_unix_process_id(&self, name: &str) -> u32 {
            match name {
                ":1.42" => 25361,
                ":1.43" => 25362,
                "org.fixture.Named" => 25363,
                other => panic!("unexpected PID lookup for {other}"),
            }
        }
    }

    /// A root never inherits its application entry's identity: a window that `GetChildren`
    /// places on another connection is unidentified, and so is a well-known destination.
    #[tokio::test]
    async fn roots_are_identified_only_by_their_own_unique_bus_owner() {
        with_peer(
            |server| {
                let node = |name, role, children: &'static [(&str, &str)]| TreeNode {
                    name,
                    role,
                    children,
                    has_text: false,
                };
                server
                    .serve_at(FIXTURE_DBUS_ROOT, OwnerBus)?
                    .serve_at(
                        FIXTURE_REGISTRY_ROOT,
                        node(
                            "Registry",
                            "desktop",
                            &[(":1.42", "/app"), ("org.fixture.Named", "/named")],
                        ),
                    )?
                    .serve_at(
                        "/app",
                        node(
                            "Editor",
                            "application",
                            &[(":1.42", "/app/window"), (":1.43", "/other/window")],
                        ),
                    )?
                    .serve_at("/app/window", node("Notes", "frame", &[]))?
                    .serve_at("/other/window", node("Foreign", "frame", &[]))?
                    .serve_at(
                        "/named",
                        node(
                            "Named",
                            "application",
                            &[("org.fixture.Named", "/named/window")],
                        ),
                    )?
                    .serve_at("/named/window", node("Named window", "frame", &[]))
            },
            async |connection| {
                let proc = ProcFixture::new(&[
                    (25361, "/usr/bin/fixture-editor"),
                    (25362, "/usr/bin/other-app"),
                    (25363, "/usr/bin/named-app"),
                ]);
                let client = peer_client(connection).with_proc_root(&proc.0);
                let roots = client.list_roots(None).await.unwrap();
                let identities = roots
                    .iter()
                    .map(|root| (root.name.as_str(), executable_name(root)))
                    .collect::<Vec<_>>();
                assert_eq!(
                    identities,
                    [
                        ("Notes", Some("fixture-editor")),
                        ("Foreign", None),
                        ("Named window", None),
                    ]
                );
                assert!(root_json("@w2", &roots[1], 1)["appId"].is_null());
            },
        )
        .await;
    }

    /// An exact root lookup reads the registry and its own connection's application only: a
    /// stalled application on another connection is never asked (#1300).
    #[tokio::test]
    async fn exact_root_reads_only_its_own_application() {
        let (stall, mut requests) = StalledReply::new();
        with_peer(
            |server| {
                let node = |name, role, children: &'static [(&str, &str)]| TreeNode {
                    name,
                    role,
                    children,
                    has_text: false,
                };
                server
                    .serve_at(FIXTURE_DBUS_ROOT, OwnerBus)?
                    .serve_at(
                        FIXTURE_REGISTRY_ROOT,
                        node(
                            "Registry",
                            "desktop",
                            &[(":1.43", "/stalled"), (":1.42", "/app")],
                        ),
                    )?
                    .serve_at("/stalled", StalledApplication(stall))?
                    .serve_at(
                        "/app",
                        node("Editor", "application", &[(":1.42", "/app/window")]),
                    )?
                    .serve_at("/app/window", node("Live title", "frame", &[]))?
                    .serve_at(
                        "/app/window",
                        WindowExtents {
                            width: 640,
                            coordinate_requests: Arc::default(),
                        },
                    )
            },
            async |connection| {
                let proc = ProcFixture::new(&[(25361, "/usr/bin/fixture-editor")]);
                let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT)
                    .with_proc_root(&proc.0);
                let at = |destination: &str, path: &str| AccessibleRef {
                    destination: destination.into(),
                    path: path.into(),
                };
                let live = client
                    .exact_root(&at(":1.42", "/app/window"))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(live.pid, 25361);
                assert_eq!(live.executable.unwrap().name, "fixture-editor");
                // The root's own live name and extents, for an X11 pairing to rank against.
                assert_eq!(live.name, "Live title");
                assert_eq!(
                    live.frame,
                    Some(Rect {
                        x: -20,
                        y: 40,
                        width: 640,
                        height: 480
                    })
                );
                // Absent only once its own application's window list completed without it.
                assert!(client
                    .exact_root(&at(":1.42", "/app/closed"))
                    .await
                    .unwrap()
                    .is_none());
                assert!(client
                    .exact_root(&at(":1.44", "/app/window"))
                    .await
                    .unwrap()
                    .is_none());
                assert!(requests.try_recv().is_err(), "asked another application");
                // Its own application stalls: unknown, never absent.
                let error = client
                    .exact_root(&at(":1.43", "/stalled/window"))
                    .await
                    .unwrap_err();
                assert_eq!(error.code, ErrorCode::Timeout);
                assert_eq!(requests.try_recv(), Ok(()));
            },
        )
        .await;
    }

    #[tokio::test]
    async fn exact_root_reports_a_stalled_registry_or_owner_lookup() {
        for stalled_pid in [false, true] {
            let (stall, mut requests) = StalledReply::new();
            with_peer(
                |server| {
                    if !stalled_pid {
                        return server.serve_at(FIXTURE_REGISTRY_ROOT, StalledRegistry(stall));
                    }
                    server
                        .serve_at(FIXTURE_DBUS_ROOT, StalledBus(stall))?
                        .serve_at(
                            FIXTURE_REGISTRY_ROOT,
                            TreeNode {
                                name: "Registry",
                                role: "desktop",
                                children: &[(":1.42", "/app")],
                                has_text: false,
                            },
                        )?
                        .serve_at(
                            "/app",
                            TreeNode {
                                name: "Editor",
                                role: "application",
                                children: &[(":1.42", "/app/window")],
                                has_text: false,
                            },
                        )
                },
                async |connection| {
                    let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT);
                    let root = AccessibleRef {
                        destination: ":1.42".into(),
                        path: "/app/window".into(),
                    };
                    let error = client.exact_root(&root).await.unwrap_err();
                    assert_eq!(requests.try_recv(), Ok(()));
                    assert_eq!(error.code, ErrorCode::Timeout);
                    let member = if stalled_pid {
                        "GetConnectionUnixProcessID"
                    } else {
                        "GetChildren"
                    };
                    assert_eq!(error.message, format!("AT-SPI2 {member} timed out"));
                },
            )
            .await;
        }
    }

    /// A descendant on another connection is never read under the root's identity.
    #[tokio::test]
    async fn snapshots_never_read_descendants_on_another_connection() {
        let foreign_text = TreeText::default();
        with_peer(
            |server| {
                server
                    .serve_at(
                        "/window",
                        TreeNode {
                            name: "frame",
                            role: "frame",
                            children: &[(":1.42", "/window/label"), (":1.43", "/foreign")],
                            has_text: false,
                        },
                    )?
                    .serve_at(
                        "/window/label",
                        TreeNode {
                            name: "label",
                            role: "label",
                            children: &[],
                            has_text: false,
                        },
                    )?
                    .serve_at(
                        "/foreign",
                        TreeNode {
                            name: "foreign secret",
                            role: "label",
                            children: &[],
                            has_text: true,
                        },
                    )?
                    .serve_at("/foreign", foreign_text.clone())
            },
            async |connection| {
                let root = AccessibleRef {
                    destination: ":1.42".into(),
                    path: "/window".into(),
                };
                let snapshot = peer_client(connection)
                    .snapshot_from(&root, 10, 10)
                    .await
                    .unwrap();
                let paths = snapshot
                    .nodes
                    .iter()
                    .map(|node| node.accessible.path.as_str())
                    .collect::<Vec<_>>();
                assert_eq!(paths, ["/window", "/window/label"]);
                assert!(snapshot.incomplete);
                assert!(snapshot.nodes[0].unread, "the parent is marked unread");
                assert!(!snapshot.nodes[1].unread);
                assert!(foreign_text.0.lock().unwrap().is_empty());
            },
        )
        .await;
    }

    /// A unique fixture procfs tree under the system temp directory, removed on drop.
    struct ProcFixture(std::path::PathBuf);

    impl ProcFixture {
        fn new(links: &[(u64, &str)]) -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let root = std::env::temp_dir()
                .join(format!("linux-bridge-proc-{}-{unique}", std::process::id()));
            for (pid, target) in links {
                let dir = root.join(pid.to_string());
                std::fs::create_dir_all(&dir).unwrap();
                std::os::unix::fs::symlink(target, dir.join("exe")).unwrap();
            }
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for ProcFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn process_executable_is_the_exe_basename_or_unattributed() {
        let fixture = ProcFixture::new(&[
            (10, "/usr/bin/KeePassXC"),
            (11, "/usr/libexec/gnome-terminal-server (deleted)"),
            (12, "/usr/bin/xdg-dbus-proxy"),
            (13, "relative/tool"),
            (14, "/"),
            (15, "/app/bin/fixture (deleted) (deleted)"),
            (16, "/opt/editor (deleted)"),
            (17, "/usr/bin/xdg-dbus-proxy (deleted)"),
        ]);
        let proc = fixture.0.as_path();
        let executable = |pid| {
            process_executable(proc, pid).map(|executable| (executable.name, executable.link_name))
        };
        let same = |name: &str| Some((name.to_owned(), name.to_owned()));
        assert_eq!(executable(10), same("KeePassXC"));
        // The ` (deleted)` suffix is ambiguous: report the stripped name, keep the literal one.
        assert_eq!(
            executable(11),
            Some((
                "gnome-terminal-server".into(),
                "gnome-terminal-server (deleted)".into()
            ))
        );
        assert_eq!(
            executable(15),
            Some((
                "fixture (deleted)".into(),
                "fixture (deleted) (deleted)".into()
            ))
        );
        assert_eq!(
            executable(16),
            Some(("editor".into(), "editor (deleted)".into()))
        );
        for pid in [0, 12, 13, 14, 17, 99] {
            assert_eq!(process_executable(proc, pid), None, "pid {pid}");
        }
    }
}
