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
/// How many live `Parent` links a scoped or explicit read may follow up to its root before it is
/// refused. Scoped looks nest, so this is above the 64-level snapshot depth clamp.
const MAX_ANCESTRY_DEPTH: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// One deadline for a whole snapshot: scope checks, traversal and final validation. Its serial
/// per-child `Parent` checks, each bounded by `REQUEST_TIMEOUT`, otherwise add up past the
/// client's 15 s deadline and keep the request slot busy after the caller gave up (#1349).
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// How many applications one `list_roots` reads at a time. Serial reads of a batched
/// inventory add up past the client's 15 s deadline (#1320); this many overlap them
/// without flooding the accessibility bus.
const LIST_ROOTS_CONCURRENCY: usize = 4;
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
pub const TEXT: &str = "org.a11y.atspi.Text";
/// The procfs mount that attributes an accessibility bus PID to its executable.
pub const PROC_ROOT: &str = "/proc";
/// Bus proxies whose connection PID is not the application's, e.g. Flatpak's
/// accessibility bus proxy, which every sandboxed app shares.
const BUS_PROXY_EXECUTABLES: [&str; 1] = ["xdg-dbus-proxy"];
/// The most of an interpreter's `/proc/<pid>/cmdline` read for its script aliases (#1333).
const MAX_CMDLINE_BYTES: usize = 32 * 1024;
/// The longest script alias reported, a file name's usual limit.
const MAX_SCRIPT_ALIAS_BYTES: usize = 255;
/// Script extensions whose stem is also an alias, so `tool` blocks `tool.py`.
const SCRIPT_EXTENSIONS: [&str; 8] = [
    ".py", ".pyw", ".pyz", ".js", ".mjs", ".cjs", ".jar", ".java",
];
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
    /// An interpreter's hosted script or module names from its app-controlled `cmdline`,
    /// e.g. `tool.py` and `tool` for `python3 /opt/tool.py`. Block-only, never identity.
    pub script_aliases: Vec<String>,
}

impl Executable {
    /// Names that may only add a block, never admit: the literal link name when it differs,
    /// then each script alias other than the identity, each once.
    pub fn block_aliases(&self) -> Vec<&str> {
        let mut aliases = Vec::new();
        let candidates = std::iter::once(self.link_name.as_str())
            .chain(self.script_aliases.iter().map(String::as_str));
        for alias in candidates {
            if alias != self.name && !aliases.contains(&alias) {
                aliases.push(alias);
            }
        }
        aliases
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
    /// Bounds one snapshot end to end, see `SNAPSHOT_TIMEOUT`.
    snapshot_timeout: Duration,
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
            snapshot_timeout: SNAPSHOT_TIMEOUT,
            input: InputState::shared(),
            proc_root: Arc::from(Path::new(PROC_ROOT)),
        }
    }

    /// Check `input`'s shutdown flag at each semantic mutation instead, e.g. in tests.
    pub fn with_input_state(self, input: Arc<InputState>) -> Self {
        Self { input, ..self }
    }

    /// Bound each snapshot by `snapshot_timeout` instead of `SNAPSHOT_TIMEOUT`, e.g. in tests.
    pub fn with_snapshot_timeout(self, snapshot_timeout: Duration) -> Self {
        Self {
            snapshot_timeout,
            ..self
        }
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

    /// The live `Parent` link, as the provider reports it now; an unimplemented `Parent` is an
    /// error here.
    async fn parent(&self, accessible: &AccessibleRef) -> Result<AccessibleRef, ProtocolError> {
        self.parent_link(accessible)
            .await?
            .ok_or_else(|| atspi_error("the provider does not implement `Parent`"))
    }

    /// The live `Parent` link, or `None` only when the provider replies that it does not
    /// implement the property (`UnknownProperty`). Any other failure, including a timeout, is
    /// an error: it does not show the provider lacks the link.
    async fn parent_link(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<Option<AccessibleRef>, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let property = "Parent";
        let reply: zbus::Result<(String, OwnedObjectPath)> =
            wait_for_reply(self.request_timeout, property, proxy.get_property(property)).await?;
        match reply {
            Ok((destination, path)) => Ok(Some(AccessibleRef {
                destination,
                path: path.to_string(),
            })),
            Err(error) if unknown_property(&error) => Ok(None),
            Err(error) => Err(atspi_error(error)),
        }
    }

    /// Whether `child`'s live `Parent` is still `parent`, the node that listed it. A failed or
    /// timed-out read, or a provider that does not implement `Parent` (`UnknownProperty`),
    /// cannot confirm the `GetChildren` edge and fails closed (#1233, #1377).
    async fn parent_is(&self, child: &AccessibleRef, parent: &AccessibleRef) -> bool {
        self.parent(child).await.is_ok_and(|live| live == *parent)
    }

    /// Refuse unless every live ancestor of `accessible`, up to and including `root`, is on the
    /// root's connection and has a confirmed readable role, so a node inside a protected
    /// container is never read on its own (#1233). A protected, unclassified or unconfirmed
    /// ancestor, a parent on another connection, a chain that leaves the root's connection or
    /// passes `MAX_ANCESTRY_DEPTH` is `secure_text_unreadable`; a failed or timed-out `Parent`
    /// read, or a failed or timed-out role read of an ancestor, keeps its own error: only a role
    /// the provider did report can refuse with that code.
    pub async fn confirm_readable_ancestry(
        &self,
        root: &AccessibleRef,
        accessible: &AccessibleRef,
    ) -> Result<(), ProtocolError> {
        let mut current = accessible.clone();
        if current == *root {
            return Ok(());
        }
        for _ in 0..MAX_ANCESTRY_DEPTH {
            current = self.parent(&current).await?;
            if current.destination != root.destination || !self.readable_node(&current).await? {
                return Err(protected_ancestry());
            }
            if current == *root {
                return Ok(());
            }
        }
        Err(protected_ancestry())
    }

    /// Refuse a scope unless `start` itself and every live ancestor up to `root` is readable,
    /// with the same rule and error codes as `confirm_readable_ancestry`; a scope equal to the
    /// root still checks the root.
    async fn confirm_readable_scope(
        &self,
        root: &AccessibleRef,
        start: &AccessibleRef,
    ) -> Result<(), ProtocolError> {
        if !self.readable_node(start).await? {
            return Err(protected_ancestry());
        }
        self.confirm_readable_ancestry(root, start).await
    }

    /// Whether the edge from `parent` to `child` may still be followed: `parent` keeps the
    /// readable role it was read with, and `child`'s live `Parent` is `parent` (#1233), see
    /// `parent_is`.
    async fn edge_confirmed(
        &self,
        parent: &AccessibleRef,
        recorded: u32,
        child: &AccessibleRef,
    ) -> bool {
        self.role_access(parent).await == RoleAccess::Readable(recorded)
            && self.parent_is(child, parent).await
    }

    /// Whether a container still has both live role fields it was read with.
    async fn still_readable(&self, accessible: &AccessibleRef, role: u32, role_name: &str) -> bool {
        self.role_access(accessible).await == RoleAccess::Readable(role)
            && self.role_name(accessible).await.ok().as_deref() == Some(role_name)
    }

    /// Whether a node's live numeric role is readable and its role name confirms it; a role or
    /// role name that could not be read is the read's error, not an answer.
    async fn readable_node(&self, accessible: &AccessibleRef) -> Result<bool, ProtocolError> {
        if classify_role(Some(self.role_id(accessible).await?))
            .readable()
            .is_none()
        {
            return Ok(false);
        }
        let name = self.role_name(accessible).await?;
        Ok(!name.trim().is_empty() && !contradicts_readable_role(&name))
    }

    async fn role_id(&self, accessible: &AccessibleRef) -> Result<u32, ProtocolError> {
        let proxy = self.proxy(accessible, ACCESSIBLE).await?;
        let member = "GetRole";
        self.request(member, proxy.call(member, &())).await
    }

    async fn role_access(&self, accessible: &AccessibleRef) -> RoleAccess {
        classify_role(self.role_id(accessible).await.ok())
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
        let connection_pid = self
            .connection_pid(accessible)
            .await?
            .map_err(atspi_error)?;
        Ok(u64::from(connection_pid))
    }

    /// The bus's reply to `GetConnectionUnixProcessID`, kept as the bus sent it so a caller can
    /// tell a connection the bus no longer has from a lookup that failed; a deadline or a proxy
    /// that could not be built is the outer error.
    async fn connection_pid(
        &self,
        accessible: &AccessibleRef,
    ) -> Result<zbus::Result<u32>, ProtocolError> {
        let bus = Proxy::new(
            &self.connection,
            DBUS_DESTINATION,
            DBUS_ROOT,
            DBUS_INTERFACE,
        )
        .await
        .map_err(atspi_error)?;
        let member = "GetConnectionUnixProcessID";
        wait_for_reply(
            self.request_timeout,
            member,
            bus.call(member, &(accessible.destination.as_str())),
        )
        .await
    }

    /// The connection PID of `accessible`'s bus owner and that process's executable. Only a
    /// unique connection name (`:1.42`) is attributed: a well-known name can change owner between
    /// requests, so it stays unidentified.
    ///
    /// The bus reports the PID the connection had when it connected, so the `exe` read counts
    /// only when the same connection still reports that PID after it (#1294). That only rejects
    /// a reused PID once the bus has already dropped the owner's connection: it does not prove
    /// the read reached the owner. A socket another process inherited keeps the connection, and
    /// a bus can answer before it processes the owner's hangup, so both still return the old
    /// PID; the `exe` changing before the read under two equal replies goes unnoticed (#1333).
    ///
    /// The outer error is the first lookup failing, or the recheck finding the connection gone
    /// (`NameHasNoOwner`): the owner is gone, as if the first lookup had failed. The inner
    /// result is the identity: unidentified on a changed PID, an error when the recheck itself
    /// failed or timed out, which says nothing about the owner.
    ///
    /// A PID outside `scope` is returned unidentified straight after the first lookup, with no
    /// `exe` read and no recheck, so a PID-scoped inventory spends one lookup per unrelated app.
    async fn bus_owner(
        &self,
        accessible: &AccessibleRef,
        scope: Option<&[u64]>,
    ) -> Result<(u64, Attribution), ProtocolError> {
        let pid = self.application_pid(accessible).await?;
        if !accessible.destination.starts_with(':')
            || scope.is_some_and(|wanted| !wanted.contains(&pid))
        {
            return Ok((pid, Ok(None)));
        }
        let Some(executable) = process_executable(&self.proc_root, pid) else {
            return Ok((pid, Ok(None)));
        };
        let attribution = match self.connection_pid(accessible).await {
            Ok(Ok(again)) => Ok((u64::from(again) == pid).then_some(executable)),
            Ok(Err(error)) if connection_gone(&error) => return Err(atspi_error(error)),
            Ok(Err(error)) => Err(atspi_error(error)),
            Err(error) => Err(error),
        };
        Ok((pid, attribution))
    }

    /// Every application's roots, or only those of the processes `filter_pids` names: a
    /// PID-scoped inventory (`Some`, even of several PIDs) fails rather than skip an app it
    /// timed out reading, since it would prove absence.
    ///
    /// Applications are read [`LIST_ROOTS_CONCURRENCY`] at a time (see [`read_bounded`]):
    /// roots keep the registry's application order, and a failure, a panicked read included,
    /// is the first failed application's in that order, whatever finished first.
    pub async fn list_roots(
        &self,
        filter_pids: Option<&[u64]>,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        self.list_roots_bounded(filter_pids, LIST_ROOTS_CONCURRENCY)
            .await
    }

    /// [`Self::list_roots`], reading at most `bound` applications at a time.
    async fn list_roots_bounded(
        &self,
        filter_pids: Option<&[u64]>,
        bound: usize,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        let registry = AccessibleRef {
            destination: REGISTRY_DESTINATION.to_owned(),
            path: REGISTRY_ROOT.to_owned(),
        };
        let applications = self.children(&registry).await?;
        let filter: Option<Arc<[u64]>> = filter_pids.map(Arc::from);
        let per_app = read_bounded(applications, bound, |app| {
            let client = self.clone();
            let filter = filter.clone();
            async move { client.app_roots(app, filter.as_deref()).await }
        })
        .await?;
        Ok(per_app.into_iter().flatten().collect())
    }

    /// The roots of one registry application `app`, or none when `filter_pids` excludes its
    /// owner; an error only when a PID-scoped inventory could not read it.
    async fn app_roots(
        &self,
        app: AccessibleRef,
        filter_pids: Option<&[u64]>,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        // A PID-scoped inventory proves absence, so an app it could not read must fail it.
        let (pid, attribution) = scoped_inventory(
            filter_pids,
            self.bus_owner(&app, filter_pids).await,
            (0, Ok(None)),
        )?;
        if filter_pids.is_some_and(|wanted| !wanted.contains(&pid)) {
            return Ok(Vec::new());
        }
        // A failed recheck leaves the owner unknown: a PID-scoped inventory fails in this app's
        // slot rather than list its root without identity, an unscoped one keeps it unidentified.
        let executable = match attribution {
            Err(error) if filter_pids.is_some() => return Err(error),
            attribution => attribution.unwrap_or(None),
        };
        let app_name = self
            .checked_metadata(&app, async || {
                self.string_property(&app, "Name").await.unwrap_or_default()
            })
            .await
            .unwrap_or_else(|_| PROTECTED_LABEL.to_owned());
        let windows = scoped_inventory(filter_pids, self.children(&app).await, Vec::new())?;
        let mut roots = Vec::new();
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
                let (pid, attribution) = self.bus_owner(root, None).await?;
                let executable = attribution?;
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

    /// Snapshot from `start` inside `root` only when `start` and every live ancestor of it up to
    /// `root` is readable, and discard the result unless they still are afterwards: a scope
    /// never escapes its own protection or that of a container above it (#1233). A protected
    /// scope refuses rather than returning a redacted node; an unscoped look uses
    /// `snapshot_from`, which redacts. Both checks and the snapshot share one
    /// `snapshot_timeout`; past it the whole snapshot is a `timeout`, never a partial one.
    pub async fn snapshot_within(
        &self,
        root: &AccessibleRef,
        start: &AccessibleRef,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Snapshot, ProtocolError> {
        wait_for_reply(self.snapshot_timeout, "snapshot", async {
            self.confirm_readable_scope(root, start).await?;
            let snapshot = self.snapshot_impl(start, max_nodes, max_depth).await?;
            self.confirm_readable_scope(root, start).await?;
            Ok(snapshot)
        })
        .await?
    }

    /// `snapshot_impl` within one `snapshot_timeout` for traversal and final validation;
    /// past it the snapshot is a `timeout`, never a partial one whose validation did not run.
    pub async fn snapshot_from(
        &self,
        start: &AccessibleRef,
        max_nodes: usize,
        max_depth: usize,
    ) -> Result<Snapshot, ProtocolError> {
        wait_for_reply(
            self.snapshot_timeout,
            "snapshot",
            self.snapshot_impl(start, max_nodes, max_depth),
        )
        .await?
    }

    /// Preserve partial observations without mistaking unread nodes for absent nodes. A
    /// protected node, or one without a confirmed role name, protects its subtree: its children
    /// are never read, and the node is `unread` when it has any (#1233). Each child is read only
    /// while the node it was listed by keeps its readable role and is the child's live `Parent`
    /// (see `parent_is`). Before returning, every container's role and every node's live
    /// `Parent` are re-read once: a container that turned protected meanwhile is redacted and
    /// its subtree dropped, and a node that moved, or whose `Parent` can no longer be read, is
    /// dropped with its subtree and its listing parent marked `unread`. It still has the node,
    /// depth and per-request bounds but no deadline of its own; `snapshot_from` adds it.
    async fn snapshot_impl(
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
        // Readable nodes whose children were queued, with the role fields they were read with.
        let mut containers: HashMap<AccessibleRef, (u32, String)> = HashMap::new();
        let mut queue = VecDeque::from([(start.clone(), None::<AccessibleRef>, 0usize)]);
        while let Some((accessible, parent, depth)) = queue.pop_front() {
            if seen.contains(&accessible) {
                continue;
            }
            if result.len() >= max_nodes || depth > max_depth {
                seen.insert(accessible);
                incomplete = true;
                unread_parents.extend(parent);
                continue;
            }
            if let Some(parent) = &parent {
                let recorded = containers[parent].0;
                // An inconsistent edge is unread, not seen: a consistent one may still reach it.
                if !self.edge_confirmed(parent, recorded, &accessible).await {
                    incomplete = true;
                    unread_parents.insert(parent.clone());
                    continue;
                }
            }
            seen.insert(accessible.clone());
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
            // A blank or failed role name does not confirm the role, so it cannot authorize
            // reading below the node either.
            match fields.readable {
                Some(id) if !fields.role.trim().is_empty() => {
                    if !children.is_empty() {
                        containers.insert(accessible.clone(), (id, fields.role.clone()));
                    }
                    for child in children {
                        queue.push_back((child, Some(accessible.clone()), depth + 1));
                    }
                }
                _ => unread |= !children.is_empty(),
            }
            incomplete |= unread;
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
        // A node that left the parent that listed it, e.g. moved into a protected container
        // while its text was read.
        let mut moved = HashSet::new();
        for node in &result {
            if let Some(parent) = &node.parent {
                if !self.parent_is(&node.accessible, parent).await {
                    moved.insert(node.accessible.clone());
                }
            }
        }
        let mut turned = HashSet::new();
        for (container, (role, role_name)) in &containers {
            if !self.still_readable(container, *role, role_name).await {
                turned.insert(container.clone());
            }
        }
        if !turned.is_empty() || !moved.is_empty() {
            incomplete = true;
            root_fields_incomplete |= turned.contains(start);
            // Breadth-first order lists every parent before its children.
            let mut dropped = HashSet::new();
            let mut abandoned = HashSet::new();
            result.retain_mut(|node| {
                let has_moved = moved.contains(&node.accessible);
                if let Some(parent) = node.parent.as_ref().filter(|_| has_moved) {
                    abandoned.insert(parent.clone());
                }
                if has_moved
                    || node
                        .parent
                        .as_ref()
                        .is_some_and(|parent| turned.contains(parent) || dropped.contains(parent))
                {
                    dropped.insert(node.accessible.clone());
                    return false;
                }
                if turned.contains(&node.accessible) {
                    let fields = NodeFields::protected(RoleAccess::Unclassified);
                    node.name = fields.name;
                    node.role = fields.role;
                    node.description = fields.description;
                    node.value.clear();
                    node.is_secure = true;
                    node.unread = true;
                }
                true
            });
            for node in &mut result {
                node.unread |= abandoned.contains(&node.accessible);
            }
        }
        Ok(Snapshot {
            nodes: result,
            incomplete,
            root_fields_incomplete,
        })
    }

    /// Authorize an explicit text read against the live role, never a cached look: a
    /// readable numeric role plus a nonblank role name that does not contradict it, and a
    /// readable live ancestry up to `root`, both before and after the read.
    pub async fn read_live_text(
        &self,
        root: &AccessibleRef,
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
        self.confirm_readable_ancestry(root, accessible).await?;
        let text = self.read_checked_text(accessible, id, &role_name).await?;
        self.confirm_readable_ancestry(root, accessible).await?;
        Ok(text)
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

/// Run `read` over `items`, at most `bound` at a time, each on its own task, and wait for
/// every one: the results keep `items` order, and the error is the first failed item's in
/// that order, whatever finished first. A read that panicked is an internal error in its own
/// slot, so it neither aborts the reads still running nor masks an earlier item's error.
async fn read_bounded<I, T, F, R>(
    items: Vec<I>,
    bound: usize,
    read: F,
) -> Result<Vec<T>, ProtocolError>
where
    I: Send + 'static,
    T: Send + 'static,
    F: Fn(I) -> R,
    R: Future<Output = Result<T, ProtocolError>> + Send + 'static,
{
    let mut slots: Vec<Option<Result<T, ProtocolError>>> =
        std::iter::repeat_with(|| None).take(items.len()).collect();
    let mut indices = HashMap::new();
    let mut pending = items.into_iter().enumerate();
    let mut reads = tokio::task::JoinSet::new();
    loop {
        while reads.len() < bound.max(1) {
            let Some((index, item)) = pending.next() else {
                break;
            };
            indices.insert(reads.spawn(read(item)).id(), index);
        }
        let Some(joined) = reads.join_next_with_id().await else {
            break;
        };
        let (id, result) = match joined {
            Ok((id, result)) => (id, result),
            Err(error) => (
                error.id(),
                Err(ProtocolError::new(
                    "An AT-SPI2 application read stopped unexpectedly",
                    ErrorCode::InternalError,
                )),
            ),
        };
        if let Some(index) = indices.remove(&id) {
            slots[index] = Some(result);
        }
    }
    slots
        .into_iter()
        .map(|slot| {
            slot.unwrap_or_else(|| {
                Err(ProtocolError::new(
                    "An AT-SPI2 application read was never joined",
                    ErrorCode::InternalError,
                ))
            })
        })
        .collect()
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
    filter_pids: Option<&[u64]>,
    result: Result<T, ProtocolError>,
    fallback: T,
) -> Result<T, ProtocolError> {
    match result {
        Err(error) if filter_pids.is_some() && error.code == ErrorCode::Timeout => Err(error),
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
/// An interpreter also reports the script aliases of its `cmdline` ([`hosted_aliases`]).
pub fn process_executable(proc_root: &Path, pid: u64) -> Option<Executable> {
    if pid == 0 {
        return None;
    }
    let process = proc_root.join(pid.to_string());
    let target = std::fs::read_link(process.join("exe")).ok()?;
    let link_name = target.to_str()?.strip_prefix('/')?.rsplit('/').next()?;
    let name = link_name.strip_suffix(" (deleted)").unwrap_or(link_name);
    if name.is_empty() || BUS_PROXY_EXECUTABLES.contains(&name) {
        return None;
    }
    let aliases = Interpreter::of(name)
        .and_then(|interpreter| {
            let cmdline = read_cmdline(&process.join("cmdline"))?;
            Some(hosted_aliases(interpreter, &cmdline))
        })
        .unwrap_or_default();
    Some(Executable {
        name: name.to_owned(),
        link_name: link_name.to_owned(),
        script_aliases: aliases,
    })
}

/// An interpreter whose executable is the host, not the app: its hosted script or module
/// comes from `cmdline`, which the process controls, so it can only add a block (#1333).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Interpreter {
    Python,
    Node,
    Java,
    Gjs,
}

/// How an interpreter reads one option token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OptionArg {
    /// A whole option: the next token is read on.
    Flag,
    /// An option whose value is the next token, skipped unread.
    Value,
    /// The next token is a module (`python -m`, `java -m`), or the inline value of
    /// `java --module=`.
    Module,
    /// The next token is a jar path (`java -jar`).
    Jar,
    /// Inline code, stdin, help or an unknown option: no script follows that this reads.
    Stop,
}

impl Interpreter {
    /// The interpreter an `exe` basename names, `None` for any other executable.
    fn of(name: &str) -> Option<Self> {
        if is_python(name) {
            return Some(Self::Python);
        }
        match name {
            "node" | "nodejs" => Some(Self::Node),
            "java" => Some(Self::Java),
            "gjs" | "gjs-console" => Some(Self::Gjs),
            _ => None,
        }
    }

    /// How this interpreter reads `token`, which starts with `-`. An option this does not
    /// know might take the next token as its value, so it stops rather than misread it.
    fn option(self, token: &str) -> OptionArg {
        match self {
            Self::Python => match token {
                "-b" | "-bb" | "-B" | "-d" | "-E" | "-i" | "-I" | "-O" | "-OO" | "-P" | "-q"
                | "-R" | "-s" | "-S" | "-u" | "-v" | "-x" => OptionArg::Flag,
                "-W" | "-X" | "--check-hash-based-pycs" => OptionArg::Value,
                "-m" => OptionArg::Module,
                _ if token.starts_with("-W") || token.starts_with("-X") => OptionArg::Flag,
                _ => OptionArg::Stop,
            },
            Self::Node => match token {
                "--inspect"
                | "--inspect-brk"
                | "--no-warnings"
                | "--no-deprecation"
                | "--trace-warnings"
                | "--enable-source-maps"
                | "--expose-gc"
                | "--preserve-symlinks"
                | "--preserve-symlinks-main"
                | "--no-addons"
                | "--abort-on-uncaught-exception"
                | "--pending-deprecation"
                | "--throw-deprecation"
                | "--trace-deprecation"
                | "--trace-uncaught"
                | "--experimental-vm-modules"
                | "--harmony" => OptionArg::Flag,
                "-r"
                | "--require"
                | "--import"
                | "--loader"
                | "--experimental-loader"
                | "-C"
                | "--conditions"
                | "--title"
                | "--input-type" => OptionArg::Value,
                _ => OptionArg::Stop,
            },
            Self::Java => match token {
                "-server" | "-client" | "-showversion" | "-esa" | "-dsa" => OptionArg::Flag,
                "-cp"
                | "-classpath"
                | "--class-path"
                | "-p"
                | "--module-path"
                | "--upgrade-module-path"
                | "--add-modules"
                | "--add-exports"
                | "--add-opens"
                | "--add-reads"
                | "--patch-module"
                | "--limit-modules"
                | "--enable-native-access"
                | "--source" => OptionArg::Value,
                "-m" | "--module" => OptionArg::Module,
                "-jar" => OptionArg::Jar,
                _ if [
                    "-D",
                    "-X",
                    "-agentlib:",
                    "-agentpath:",
                    "-javaagent:",
                    "-ea",
                    "-da",
                    "-enableassertions",
                    "-disableassertions",
                    "-verbose",
                    "-splash:",
                ]
                .iter()
                .any(|prefix| token.starts_with(prefix)) =>
                {
                    OptionArg::Flag
                }
                _ => OptionArg::Stop,
            },
            Self::Gjs => match token {
                "-m" | "--module" | "-d" | "--debugger" => OptionArg::Flag,
                "-I" | "--include-path" | "--coverage-prefix" | "--coverage-output" => {
                    OptionArg::Value
                }
                _ => OptionArg::Stop,
            },
        }
    }

    /// How this interpreter reads a `--name=value` token by its `name`. Only a known option
    /// that takes a value (now inline), `java --module=` or an allowlisted `=` form is read
    /// on; any other, e.g. `--eval=code` or an unknown option, stops: whether the next token
    /// is the script or an app argument is unknowable, and an argument may be a secret.
    fn inline_option(self, name: &str) -> OptionArg {
        match self.option(name) {
            OptionArg::Value => OptionArg::Flag,
            OptionArg::Module if self == Self::Java => OptionArg::Module,
            _ if self == Self::Node && NODE_INLINE_OPTIONS.contains(&name) => OptionArg::Flag,
            _ => OptionArg::Stop,
        }
    }
}

/// Node options read whole only in their `--name=value` form.
const NODE_INLINE_OPTIONS: [&str; 5] = [
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
    "--max-old-space-size",
    "--stack-size",
];

/// Whether an `exe` basename is `python`, `python3` or `python3.12`: `python` plus a
/// version of dot-separated digit runs.
fn is_python(name: &str) -> bool {
    name.strip_prefix("python").is_some_and(|version| {
        version.is_empty()
            || version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

/// `cmdline` at `path`, read only from a regular file and at most [`MAX_CMDLINE_BYTES`], or
/// `None` when it cannot be read. A longer one keeps only its complete leading tokens.
fn read_cmdline(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    if !std::fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_CMDLINE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_CMDLINE_BYTES {
        bytes.truncate(MAX_CMDLINE_BYTES);
        let complete = bytes
            .iter()
            .rposition(|&byte| byte == 0)
            .map_or(0, |end| end + 1);
        bytes.truncate(complete);
    }
    Some(bytes)
}

/// The block-only names of the script or module `interpreter` runs per its NUL-separated
/// `cmdline`: one conservative rule, the first token after the options that the
/// interpreter runs, so never an option value, inline code or a later app argument. Only
/// that token's basename (and stem, e.g. `tool` of `tool.py`) or module name is kept,
/// never the rest of argv, which can carry secrets. Anything it cannot read whole as
/// that (non-UTF-8, an unknown option or `=` option, a control character, past 255
/// bytes) is no alias.
fn hosted_aliases(interpreter: Interpreter, cmdline: &[u8]) -> Vec<String> {
    let java = interpreter == Interpreter::Java;
    let mut tokens = cmdline.split(|&byte| byte == 0).skip(1);
    let mut options = true;
    while let Some(token) = tokens.next() {
        let Ok(token) = std::str::from_utf8(token) else {
            return Vec::new();
        };
        let (kind, inline) = match token {
            "--" if options => {
                options = false;
                continue;
            }
            "-" => (OptionArg::Stop, None),
            _ if options && token.starts_with('-') => match token.split_once('=') {
                Some((name, value)) if token.starts_with("--") => {
                    (interpreter.inline_option(name), Some(value))
                }
                _ => (interpreter.option(token), None),
            },
            // `java Tool.java` runs a source file; any other Java target is a class name.
            _ if java && token.ends_with(".java") => return file_aliases(token),
            _ if java && token.starts_with('@') => (OptionArg::Stop, None),
            _ if java => return module_aliases(token, false),
            _ => return file_aliases(token),
        };
        let mut value = || {
            inline.or_else(|| {
                tokens
                    .next()
                    .and_then(|value| std::str::from_utf8(value).ok())
            })
        };
        match kind {
            OptionArg::Flag => {}
            OptionArg::Value => {
                value();
            }
            OptionArg::Module => {
                return value().map_or_else(Vec::new, |module| module_aliases(module, java));
            }
            OptionArg::Jar => return value().map_or_else(Vec::new, file_aliases),
            OptionArg::Stop => return Vec::new(),
        }
    }
    Vec::new()
}

/// A script path's basename, plus its stem for a known script extension.
fn file_aliases(path: &str) -> Vec<String> {
    let Some(basename) = path.rsplit('/').next().filter(|name| is_hosted_name(name)) else {
        return Vec::new();
    };
    let stem = SCRIPT_EXTENSIONS
        .iter()
        .find_map(|extension| basename.strip_suffix(extension))
        .filter(|stem| is_hosted_name(stem));
    std::iter::once(basename)
        .chain(stem)
        .map(str::to_owned)
        .collect()
}

/// A dotted module or class name (`pkg.tool`, `org.example.Main`), plus a Java
/// `module/class` pair's two names when `split_main` is set. A name with any other
/// character is no alias.
fn module_aliases(module: &str, split_main: bool) -> Vec<String> {
    let names: Vec<&str> = if split_main {
        module.split('/').collect()
    } else {
        vec![module]
    };
    let dotted = |name: &&str| {
        is_hosted_name(name)
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'$'))
    };
    if names.len() > 2 || !names.iter().all(dotted) {
        return Vec::new();
    }
    names.into_iter().map(str::to_owned).collect()
}

/// Whether `name` is reportable as a script, module or class alias: a non-empty name other
/// than `.` and `..`, at most [`MAX_SCRIPT_ALIAS_BYTES`], with no control character.
fn is_hosted_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_SCRIPT_ALIAS_BYTES
        && name != "."
        && name != ".."
        && !name.chars().any(char::is_control)
}

fn protected_ancestry() -> ProtocolError {
    ProtocolError::new(
        "Cannot confirm that every live ancestor up to the root permits reading",
        ErrorCode::SecureTextUnreadable,
    )
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

/// A bus owner's executable once the bus still reported its PID after the read, `None` when it
/// stays unidentified, or the error of a recheck that could not tell (#1294).
type Attribution = Result<Option<Executable>, ProtocolError>;

/// The bus no longer has the connection, so its owner is gone.
fn connection_gone(error: &zbus::Error) -> bool {
    matches!(error, zbus::Error::MethodError(name, _, _)
        if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner")
}

/// The provider replied `org.freedesktop.DBus.Error.UnknownProperty`: the object does not
/// implement the property. `Properties.Get` replies parse as `fdo::Error`, so that name always
/// arrives as this variant.
fn unknown_property(error: &zbus::Error) -> bool {
    matches!(error, zbus::Error::FDO(error) if matches!(**error, zbus::fdo::Error::UnknownProperty(_)))
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
        /// The live `Parent` (bus name, path); `None` does not implement the property.
        parent: Option<(&'static str, &'static str)>,
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

        #[zbus(property)]
        fn parent(&self) -> zbus::fdo::Result<(&str, OwnedObjectPath)> {
            let (destination, path) = self
                .parent
                .ok_or_else(|| zbus::fdo::Error::UnknownProperty("no Parent".into()))?;
            Ok((destination, OwnedObjectPath::try_from(path).unwrap()))
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
                    parent: None,
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

                let matching = client.list_roots(Some(&[25361])).await.unwrap();
                assert_eq!(
                    matching
                        .iter()
                        .map(|root| root.accessible.path.as_str())
                        .collect::<Vec<_>>(),
                    [WINDOW, DIALOG]
                );
                assert!(client.list_roots(Some(&[25362])).await.unwrap().is_empty());
                // One inventory of several processes lists the roots of any of them.
                let several = client.list_roots(Some(&[25362, 25361])).await.unwrap();
                assert_eq!(
                    several
                        .iter()
                        .map(|root| root.accessible.path.as_str())
                        .collect::<Vec<_>>(),
                    [WINDOW, DIALOG]
                );

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
                            parent: None,
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
                        parent: None,
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
                    let error = client.list_roots(Some(&[25361])).await.unwrap_err();
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
                        assert!(client.list_roots(Some(&[25362])).await.unwrap().is_empty());
                    }
                },
            )
            .await;
        }
    }

    /// The read bound #1320 asks for, pinned here so a changed `LIST_ROOTS_CONCURRENCY`
    /// fails the tests instead of moving them along with it.
    const READ_BOUND: usize = 4;

    /// Window paths of the gated applications, one per application.
    const GATED_WINDOWS: [&str; 8] = [
        "/app0/window",
        "/app1/window",
        "/app2/window",
        "/app3/window",
        "/app4/window",
        "/app5/window",
        "/app6/window",
        "/app7/window",
    ];

    /// Holds each application `GetChildren` read until its whole wave of `wave` reads has
    /// arrived (the last wave is whatever is left of `total`): only reads overlapped `wave`
    /// at a time ever get a reply.
    struct ReadGate {
        wave: usize,
        total: usize,
        arrived: tokio::sync::watch::Sender<usize>,
    }

    impl ReadGate {
        fn new(wave: usize, total: usize) -> Arc<Self> {
            Arc::new(Self {
                wave,
                total,
                arrived: tokio::sync::watch::Sender::new(0),
            })
        }

        async fn pass(&self) {
            let mut arrival = 0;
            self.arrived.send_modify(|arrived| {
                arrival = *arrived;
                *arrived += 1;
            });
            let released = ((arrival / self.wave + 1) * self.wave).min(self.total);
            let _ = self
                .arrived
                .subscribe()
                .wait_for(|&arrived| arrived >= released)
                .await;
        }
    }

    /// Holds each application `GetChildren` read until the test releases it, counting the
    /// reads outstanding at once: each release round stands in for one provider delay.
    struct CountingGate {
        outstanding: tokio::sync::watch::Sender<usize>,
        finished: tokio::sync::watch::Sender<usize>,
        most: std::sync::atomic::AtomicUsize,
        release: tokio::sync::Semaphore,
    }

    impl CountingGate {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                outstanding: tokio::sync::watch::Sender::new(0),
                finished: tokio::sync::watch::Sender::new(0),
                most: std::sync::atomic::AtomicUsize::new(0),
                release: tokio::sync::Semaphore::new(0),
            })
        }

        async fn pass(&self) {
            self.outstanding.send_modify(|outstanding| {
                *outstanding += 1;
                self.most
                    .fetch_max(*outstanding, std::sync::atomic::Ordering::SeqCst);
            });
            self.release.acquire().await.unwrap().forget();
            self.outstanding
                .send_modify(|outstanding| *outstanding -= 1);
            self.finished.send_modify(|finished| *finished += 1);
        }

        /// Release `total` reads in rounds of `wave`, each once a whole wave is outstanding
        /// and after the previous one finished: the number of rounds, i.e. provider delays
        /// the listing waits out.
        async fn release_in_rounds(&self, total: usize, wave: usize) -> usize {
            let mut outstanding = self.outstanding.subscribe();
            let mut finished = self.finished.subscribe();
            let (mut released, mut rounds) = (0, 0);
            while released < total {
                let round = wave.min(total - released);
                outstanding.wait_for(|&n| n >= round).await.unwrap();
                self.release.add_permits(round);
                released += round;
                rounds += 1;
                finished.wait_for(|&n| n >= released).await.unwrap();
            }
            rounds
        }
    }

    enum Gate {
        Wave(Arc<ReadGate>),
        Counting(Arc<CountingGate>),
    }

    /// An application whose window inventory replies only through a shared [`Gate`].
    struct GatedApplication {
        window: &'static str,
        gate: Arc<Gate>,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl GatedApplication {
        #[zbus(property)]
        fn name(&self) -> &str {
            "Gated"
        }

        fn get_role(&self) -> u32 {
            75
        }

        async fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
            match &*self.gate {
                Gate::Wave(gate) => gate.pass().await,
                Gate::Counting(gate) => gate.pass().await,
            }
            vec![(
                ":1.42".to_owned(),
                OwnedObjectPath::try_from(self.window).unwrap(),
            )]
        }
    }

    const GATED_APPS: [(&str, &str); 8] = [
        (":1.42", "/app0"),
        (":1.42", "/app1"),
        (":1.42", "/app2"),
        (":1.42", "/app3"),
        (":1.42", "/app4"),
        (":1.42", "/app5"),
        (":1.42", "/app6"),
        (":1.42", "/app7"),
    ];

    /// Serve eight applications whose `GetChildren` replies pass through `gate`.
    fn serve_gated(
        server: zbus::connection::Builder<'static>,
        gate: Gate,
    ) -> zbus::Result<zbus::connection::Builder<'static>> {
        let gate = Arc::new(gate);
        let mut server = server.serve_at(FIXTURE_DBUS_ROOT, MockBus)?.serve_at(
            FIXTURE_REGISTRY_ROOT,
            TreeNode {
                name: "Registry",
                role: "desktop",
                children: &GATED_APPS,
                has_text: false,
                parent: None,
            },
        )?;
        for ((_, app), window) in GATED_APPS.into_iter().zip(GATED_WINDOWS) {
            server = server
                .serve_at(
                    app,
                    GatedApplication {
                        window,
                        gate: Arc::clone(&gate),
                    },
                )?
                .serve_at(
                    window,
                    TreeNode {
                        name: window,
                        role: "frame",
                        children: &[],
                        has_text: false,
                        parent: None,
                    },
                )?;
        }
        Ok(server)
    }

    fn window_paths(roots: &[RootSnapshot]) -> Vec<&str> {
        roots
            .iter()
            .map(|root| root.accessible.path.as_str())
            .collect()
    }

    /// List the roots of eight gated applications, read through [`ReadGate`]s of `wave`.
    async fn list_wave_gated_roots(
        wave: usize,
        request_timeout: Duration,
    ) -> Result<Vec<RootSnapshot>, ProtocolError> {
        let gate = ReadGate::new(wave, GATED_APPS.len());
        with_peer(
            |server| serve_gated(server, Gate::Wave(gate)),
            async |connection| {
                AtspiClient::from_connection(connection, request_timeout)
                    .list_roots(Some(&[25361]))
                    .await
            },
        )
        .await
    }

    #[tokio::test]
    async fn list_roots_never_overlaps_more_reads_than_its_bound() {
        // Reads overlapped up to the bound all reply, and roots keep registry order.
        let roots = list_wave_gated_roots(READ_BOUND, REQUEST_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(window_paths(&roots), GATED_WINDOWS);
        // A wave one larger never fills, so its reads time out and the scoped inventory
        // fails rather than skip them.
        let error = list_wave_gated_roots(READ_BOUND + 1, STALLED_REQUEST_TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.message, "AT-SPI2 GetChildren timed out");
    }

    /// List the eight counting-gated applications, through `list_roots` (`None`) or at most
    /// `bound` at a time, releasing their reads in rounds of that bound: the roots, the rounds
    /// waited out, and the most reads ever outstanding at once.
    async fn list_counting_gated_roots(bound: Option<usize>) -> (Vec<RootSnapshot>, usize, usize) {
        let gate = CountingGate::new();
        let controller = Arc::clone(&gate);
        let wave = bound.unwrap_or(READ_BOUND);
        with_peer(
            |server| serve_gated(server, Gate::Counting(gate)),
            async |connection| {
                let client = AtspiClient::from_connection(connection, REQUEST_TIMEOUT);
                let list = async {
                    match bound {
                        Some(bound) => client.list_roots_bounded(Some(&[25361]), bound).await,
                        None => client.list_roots(Some(&[25361])).await,
                    }
                };
                let (roots, rounds) =
                    tokio::join!(list, controller.release_in_rounds(GATED_APPS.len(), wave));
                let most = controller.most.load(std::sync::atomic::Ordering::SeqCst);
                (roots.unwrap(), rounds, most)
            },
        )
        .await
    }

    #[tokio::test]
    async fn batched_list_roots_bounds_serial_provider_latency() {
        // Each release round stands in for one provider delay (e.g. 1.7 s per `GetChildren`).
        // Read one at a time, eight apps wait out eight of them.
        let (roots, rounds, most) = list_counting_gated_roots(Some(1)).await;
        assert_eq!(window_paths(&roots), GATED_WINDOWS);
        assert_eq!((rounds, most), (GATED_APPS.len(), 1));
        // `list_roots` reaches its bound of outstanding reads and never passes it, so the
        // same eight apps wait out ceil(8 / 4) = 2 delays, and roots keep registry order.
        let (roots, rounds, most) = list_counting_gated_roots(None).await;
        assert_eq!(window_paths(&roots), GATED_WINDOWS);
        assert_eq!(
            (rounds, most),
            (GATED_APPS.len().div_ceil(READ_BOUND), READ_BOUND)
        );
    }

    type BoxedRead = std::pin::Pin<Box<dyn Future<Output = Result<u8, ProtocolError>> + Send>>;

    fn failed(message: &str) -> Result<u8, ProtocolError> {
        Err(ProtocolError::new(message, ErrorCode::Timeout))
    }

    #[tokio::test]
    async fn bounded_reads_report_the_first_failure_in_registry_order() {
        // The first read fails only once the second has failed, so the second fails first in
        // time; the first in registry order is still the one reported.
        let (second_done, first_gate) = tokio::sync::oneshot::channel();
        let first: BoxedRead = Box::pin(async move {
            first_gate.await.unwrap();
            failed("first app")
        });
        let second: BoxedRead = Box::pin(async move {
            let result = failed("second app");
            second_done.send(()).unwrap();
            result
        });
        let error = read_bounded(vec![first, second], READ_BOUND, |read| read)
            .await
            .unwrap_err();
        assert_eq!(error.message, "first app");
    }

    /// Releases the read waiting on it once dropped, e.g. by a panic unwinding.
    struct ReleaseOnDrop(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            if let Some(release) = self.0.take() {
                let _ = release.send(());
            }
        }
    }

    fn panicking_read() -> Result<u8, ProtocolError> {
        panic!("application read panicked")
    }

    #[tokio::test]
    async fn list_roots_orders_panics_by_registry_index() {
        // A later read panics before an earlier one fails: the panic fills only its own slot,
        // the earlier read still runs to its own error, and that error is reported.
        let (release, released) = tokio::sync::oneshot::channel();
        let earlier: BoxedRead = Box::pin(async move {
            released.await.unwrap();
            failed("earlier app")
        });
        let later: BoxedRead = Box::pin(async move {
            let _release = ReleaseOnDrop(Some(release));
            panicking_read()
        });
        let error = read_bounded(vec![earlier, later], READ_BOUND, |read| read)
            .await
            .unwrap_err();
        assert_eq!(error.message, "earlier app");
        // Alone, the panic is an internal error, and later reads still run to completion.
        let (finished, finished_read) = tokio::sync::oneshot::channel();
        let reads: Vec<BoxedRead> = vec![
            Box::pin(async { Ok(1) }),
            Box::pin(async { panicking_read() }),
            Box::pin(async move {
                finished.send(()).unwrap();
                Ok(3)
            }),
        ];
        let error = read_bounded(reads, 1, |read| read).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InternalError);
        assert_eq!(
            error.message,
            "An AT-SPI2 application read stopped unexpectedly"
        );
        assert_eq!(finished_read.await, Ok(()));
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
                            parent: None,
                        },
                    )?
                    .serve_at(
                        PASSWORD,
                        TreeNode {
                            name: "PaSsWoRd TeXt",
                            role: "PaSsWoRd TeXt",
                            children: &[],
                            has_text: true,
                            parent: Some((DESTINATION, ROOT)),
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
                            parent: Some((DESTINATION, ROOT)),
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
                script_aliases: Vec::new(),
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
            script_aliases: Vec::new(),
        });
        let replaced = root_json("@w3", &replaced, 0);
        assert_eq!(replaced["appId"], "editor");
        assert_eq!(replaced["blockAliases"], json!(["editor (deleted)"]));

        // An interpreter keeps its own identity; its script names are block-only, each once.
        let mut hosted = root.clone();
        hosted.wm_class = None;
        hosted.class_candidates = vec![("tool".into(), "Tool".into())];
        hosted.executable = Some(Executable {
            name: "python3".into(),
            link_name: "python3 (deleted)".into(),
            script_aliases: vec!["tool.py".into(), "tool".into(), "python3".into()],
        });
        let hosted = root_json("@w4", &hosted, 0);
        assert_eq!(hosted["appId"], "python3");
        assert_eq!(hosted["processName"], "python3");
        assert_eq!(
            hosted["blockAliases"],
            json!(["python3 (deleted)", "tool.py", "tool", "Tool"])
        );

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
                    parent: None,
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

    /// One scripted answer to `GetConnectionUnixProcessID`.
    #[derive(Clone, Copy, Debug)]
    enum Lookup {
        Pid(u32),
        /// The bus no longer has the connection: `NameHasNoOwner`.
        Gone,
        /// Any other bus error, which says nothing about the owner.
        Failed,
        /// Never answered.
        Stalled,
        /// [`Lookup::Failed`], but only once another connection's lookup has failed: a reader
        /// that waits for this app before reading the others never gets this reply.
        FailedAfterAnother,
    }

    /// One scripted lookup and the `exe` target the fixture PID links to from then on.
    type PidReply = (Lookup, Option<&'static str>);

    /// One connection's scripted PID lookups, how many lookups it was sent, and the `exe` link
    /// of the PID its replies name.
    struct OwnerScript {
        replies: std::collections::VecDeque<PidReply>,
        scripted: usize,
        requests: usize,
        exe: std::path::PathBuf,
    }

    /// A bus answering connection PID lookups from a script per connection name, so lookups for
    /// different apps read at once still consume each app's replies in order. A reply can
    /// relink its PID's `exe` before it is sent, as a PID reused right after the lookup would
    /// (#1294).
    struct ScriptedBus {
        scripts: Arc<Mutex<HashMap<String, OwnerScript>>>,
        /// Set once any [`Lookup::Failed`] reply was sent.
        failed: tokio::sync::watch::Sender<bool>,
    }

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl ScriptedBus {
        #[zbus(name = "GetConnectionUnixProcessID")]
        async fn get_connection_unix_process_id(&self, name: &str) -> zbus::fdo::Result<u32> {
            let lookup = {
                let mut scripts = self.scripts.lock().unwrap();
                let script = scripts.get_mut(name).expect("unscripted connection");
                script.requests += 1;
                // An unscripted lookup fails, and the request count catches it afterwards.
                let (lookup, relink) = script.replies.pop_front().unwrap_or((Lookup::Failed, None));
                if let Some(target) = relink {
                    std::fs::remove_file(&script.exe).unwrap();
                    std::os::unix::fs::symlink(target, &script.exe).unwrap();
                }
                lookup
            };
            match lookup {
                Lookup::Pid(pid) => Ok(pid),
                Lookup::Gone => Err(zbus::fdo::Error::NameHasNoOwner(format!("{name} is gone"))),
                Lookup::Failed => {
                    self.failed.send_replace(true);
                    Err(zbus::fdo::Error::Failed(format!("{name} overloaded")))
                }
                Lookup::Stalled => std::future::pending().await,
                Lookup::FailedAfterAnother => {
                    let mut failed = self.failed.subscribe();
                    failed.wait_for(|failed| *failed).await.unwrap();
                    Err(zbus::fdo::Error::Failed(format!("{name} overloaded")))
                }
            }
        }
    }

    /// The scripted owners' applications: `/app` (`Editor`, window `/app/window`) on `:1.42`
    /// and `/viewer` (`Viewer`, window `/viewer/window`) on `:1.43`.
    const SCRIPTED_APPS: [(&str, &str); 2] = [(":1.42", "/app"), (":1.43", "/viewer")];

    /// Exercise the applications `registry` lists (of [`SCRIPTED_APPS`]), each connection's
    /// bus owner answering PID lookups from its `(connection, pid, exe target, script)` in
    /// `owners`, then check the helper asked for every scripted reply.
    async fn with_scripted_owners<T>(
        registry: &'static [(&'static str, &'static str)],
        owners: &[(&str, u64, &str, &[PidReply])],
        exercise: impl AsyncFnOnce(&AtspiClient) -> T,
    ) -> T {
        let links: Vec<_> = owners.iter().map(|&(_, pid, exe, _)| (pid, exe)).collect();
        let proc = ProcFixture::new(&links);
        let scripts = Arc::new(Mutex::new(
            owners
                .iter()
                .map(|&(connection, pid, _, script)| {
                    let replies = script.iter().copied().collect();
                    let exe = proc.0.join(pid.to_string()).join("exe");
                    let script = OwnerScript {
                        replies,
                        scripted: script.len(),
                        requests: 0,
                        exe,
                    };
                    (connection.to_owned(), script)
                })
                .collect::<HashMap<_, _>>(),
        ));
        let bus = ScriptedBus {
            scripts: Arc::clone(&scripts),
            failed: tokio::sync::watch::Sender::new(false),
        };
        with_peer(
            |server| {
                let node = |name, role, children: &'static [(&str, &str)]| TreeNode {
                    name,
                    role,
                    children,
                    has_text: false,
                    parent: None,
                };
                server
                    .serve_at(FIXTURE_DBUS_ROOT, bus)?
                    .serve_at(FIXTURE_REGISTRY_ROOT, node("Registry", "desktop", registry))?
                    .serve_at(
                        "/app",
                        node("Editor", "application", &[(":1.42", "/app/window")]),
                    )?
                    .serve_at("/app/window", node("Notes", "frame", &[]))?
                    .serve_at(
                        "/viewer",
                        node("Viewer", "application", &[(":1.43", "/viewer/window")]),
                    )?
                    .serve_at("/viewer/window", node("Photos", "frame", &[]))
            },
            async |connection| {
                let client = AtspiClient::from_connection(connection, STALLED_REQUEST_TIMEOUT)
                    .with_proc_root(&proc.0);
                let result = exercise(&client).await;
                let scripts = scripts.lock().unwrap();
                // Exactly the scripted lookups: none left unasked, none asked beyond them.
                assert!(
                    scripts
                        .values()
                        .all(|script| script.requests == script.scripted),
                    "{owners:?}"
                );
                result
            },
        )
        .await
    }

    /// Exercise one fixture root on `:1.42` whose bus answers PID lookups from `script`, then
    /// check the helper asked for every scripted reply.
    async fn with_scripted_owner<T>(
        script: &[PidReply],
        exercise: impl AsyncFnOnce(&AtspiClient) -> T,
    ) -> T {
        with_scripted_owners(
            &SCRIPTED_APPS[..1],
            &[(":1.42", 25361, "/usr/bin/fixture-editor", script)],
            exercise,
        )
        .await
    }

    const REUSED: &str = "/usr/bin/reused-pid";

    /// The `exe` read counts only while the root's connection still reports the same PID after
    /// it (#1294). A gone connection means the owner is gone; a recheck that failed or timed out
    /// leaves the owner unknown: an unscoped listing keeps the root unidentified, a PID-scoped
    /// one fails rather than list it without identity.
    #[tokio::test]
    async fn identity_needs_the_same_bus_owner_after_the_exe_read() {
        use Lookup::{Failed, Gone, Pid, Stalled};
        type Listed = Result<&'static [(u64, Option<&'static str>)], ErrorCode>;
        const EDITOR: Listed = Ok(&[(25361, Some("fixture-editor"))]);
        const UNIDENTIFIED: Listed = Ok(&[(25361, None)]);
        // (script, unscoped listing, listing scoped to 25361)
        let cases: [(&[PidReply], Listed, Listed); 7] = [
            (&[(Pid(25361), None), (Pid(25361), None)], EDITOR, EDITOR),
            // The owner exits and its PID is reused before the read: the connection is gone.
            (
                &[(Pid(25361), Some(REUSED)), (Gone, None)],
                Ok(&[(0, None)]),
                Ok(&[]),
            ),
            (
                &[(Pid(25361), None), (Pid(25362), None)],
                UNIDENTIFIED,
                UNIDENTIFIED,
            ),
            // A PID reused only after the recheck: the read already named the live owner.
            (
                &[(Pid(25361), None), (Pid(25361), Some(REUSED))],
                EDITOR,
                EDITOR,
            ),
            (
                &[(Pid(25361), None), (Failed, None)],
                UNIDENTIFIED,
                Err(ErrorCode::InternalError),
            ),
            (
                &[(Pid(25361), None), (Stalled, None)],
                UNIDENTIFIED,
                Err(ErrorCode::Timeout),
            ),
            // Known limit (#1333): the `exe` changed before the read but both replies match, as
            // with an inherited socket or a bus still processing the hangup, so the new
            // executable is accepted.
            (
                &[(Pid(25361), Some(REUSED)), (Pid(25361), None)],
                Ok(&[(25361, Some("reused-pid"))]),
                Ok(&[(25361, Some("reused-pid"))]),
            ),
        ];
        for (script, unscoped, scoped) in cases {
            for (filter, expected) in [(None, unscoped), (Some(&[25361_u64][..]), scoped)] {
                let listed = with_scripted_owner(script, async |client| {
                    client.list_roots(filter).await.map(|roots| {
                        roots
                            .iter()
                            .map(|root| (root.pid, executable_name(root).map(str::to_owned)))
                            .collect::<Vec<_>>()
                    })
                })
                .await;
                let expected = expected.map(|roots| {
                    roots
                        .iter()
                        .map(|&(pid, name)| (pid, name.map(str::to_owned)))
                        .collect::<Vec<_>>()
                });
                assert_eq!(
                    listed.map_err(|error| error.code),
                    expected,
                    "{script:?} {filter:?}"
                );
            }
        }
    }

    /// A saved root's lookup (`atspiLookRoot`) shares the recheck: a changed PID is
    /// unidentified, and a gone, failed or stalled recheck fails the lookup.
    #[tokio::test]
    async fn exact_root_needs_the_same_bus_owner_after_the_exe_read() {
        use Lookup::{Failed, Gone, Pid, Stalled};
        /// The looked-up root's executable name, or the lookup's error.
        type Found = Result<Option<&'static str>, ErrorCode>;
        let cases: [(&[PidReply], Found); 5] = [
            (
                &[(Pid(25361), None), (Pid(25361), None)],
                Ok(Some("fixture-editor")),
            ),
            (&[(Pid(25361), None), (Pid(25362), None)], Ok(None)),
            (
                &[(Pid(25361), Some(REUSED)), (Gone, None)],
                Err(ErrorCode::InternalError),
            ),
            (
                &[(Pid(25361), None), (Failed, None)],
                Err(ErrorCode::InternalError),
            ),
            (
                &[(Pid(25361), None), (Stalled, None)],
                Err(ErrorCode::Timeout),
            ),
        ];
        let root = AccessibleRef {
            destination: ":1.42".into(),
            path: "/app/window".into(),
        };
        for (script, expected) in cases {
            let found = with_scripted_owner(script, async |client| {
                client.exact_root(&root).await.map(|live| {
                    let live = live.expect("the root is listed");
                    assert_eq!(live.pid, 25361);
                    live.executable.map(|executable| executable.name)
                })
            })
            .await;
            assert_eq!(
                found.map_err(|error| error.code),
                expected.map(|name| name.map(str::to_owned)),
                "{script:?}"
            );
        }
    }

    /// Every app read at once rechecks its own owner (#1294): a failed recheck is that app's
    /// error in its registry slot. An unscoped listing keeps that root unidentified beside an
    /// identified one, a PID-scoped listing fails with the first failed app in registry order
    /// even when a later app failed first, and never rechecks an app outside its PIDs.
    #[tokio::test]
    async fn concurrent_reads_recheck_each_bus_owner_in_its_own_slot() {
        use Lookup::{Failed, FailedAfterAnother, Pid};
        const EDITOR: &str = "/usr/bin/fixture-editor";
        const VIEWER: &str = "/usr/bin/fixture-viewer";
        type Listed = Result<Vec<(u64, Option<String>)>, (ErrorCode, String)>;
        let identified = |pid, name: Option<&str>| (pid, name.map(str::to_owned));
        let list = async |editor: &[PidReply], viewer: &[PidReply], filter: Option<&[u64]>| {
            let owners = [
                (":1.42", 25361, EDITOR, editor),
                (":1.43", 25362, VIEWER, viewer),
            ];
            let listed: Listed = with_scripted_owners(&SCRIPTED_APPS, &owners, async |client| {
                client
                    .list_roots(filter)
                    .await
                    .map(|roots| {
                        roots
                            .iter()
                            .map(|root| (root.pid, executable_name(root).map(str::to_owned)))
                            .collect()
                    })
                    .map_err(|error| (error.code, error.message))
            })
            .await;
            listed
        };
        let code = |listed: Listed| listed.map_err(|(code, _)| code);
        let same = [(Pid(25361), None), (Pid(25361), None)];
        let viewer_same = [(Pid(25362), None), (Pid(25362), None)];
        assert_eq!(
            list(&[(Pid(25361), None), (Failed, None)], &viewer_same, None).await,
            Ok(vec![
                identified(25361, None),
                identified(25362, Some("fixture-viewer"))
            ])
        );
        assert_eq!(
            code(
                list(
                    &same,
                    &[(Pid(25362), None), (Failed, None)],
                    Some(&[25361, 25362])
                )
                .await
            ),
            Err(ErrorCode::InternalError)
        );
        // The editor's recheck fails only once the viewer's has: a reader that finished the
        // editor before reading the viewer would time out on it instead. The editor is first in
        // registry order, so its failure is the error though it came second.
        let (error, message) = list(
            &[(Pid(25361), None), (FailedAfterAnother, None)],
            &[(Pid(25362), None), (Failed, None)],
            Some(&[25361, 25362]),
        )
        .await
        .unwrap_err();
        assert_eq!(error, ErrorCode::InternalError, "{message}");
        assert!(message.contains(":1.42 overloaded"), "{message}");
        // The editor is outside the PIDs: one lookup, no recheck.
        assert_eq!(
            list(&[(Pid(25361), None)], &viewer_same, Some(&[25362])).await,
            Ok(vec![identified(25362, Some("fixture-viewer"))])
        );
    }

    /// Unrelated applications for [`scoped_inventory_skips_unrelated_rechecks`], none served:
    /// a PID-scoped listing that skips them never reads them past the PID lookup.
    const UNRELATED_APPS: [(&str, &str); 6] = [
        (":1.42", "/app"),
        (":1.50", "/other"),
        (":1.51", "/other"),
        (":1.52", "/other"),
        (":1.53", "/other"),
        (":1.54", "/other"),
    ];

    /// A PID-scoped listing filters on the first lookup's PID before the `exe` read, so an app
    /// outside its PIDs costs one lookup and no recheck, keeping a busy bus inside the
    /// inventory deadline; the wanted app is still rechecked.
    #[tokio::test]
    async fn scoped_inventory_skips_unrelated_rechecks() {
        use Lookup::Pid;
        let unrelated: Vec<_> = UNRELATED_APPS[1..]
            .iter()
            .zip(30001_u32..)
            .map(|(&(connection, _), pid)| (connection, pid))
            .collect();
        let scripts: Vec<[PidReply; 1]> = unrelated
            .iter()
            .map(|&(_, pid)| [(Pid(pid), None)])
            .collect();
        let editor = [(Pid(25361), None), (Pid(25361), None)];
        let mut owners = vec![(":1.42", 25361, "/usr/bin/fixture-editor", &editor[..])];
        owners.extend(
            unrelated
                .iter()
                .zip(&scripts)
                .map(|(&(connection, pid), script)| {
                    (
                        connection,
                        u64::from(pid),
                        "/usr/bin/unrelated",
                        &script[..],
                    )
                }),
        );
        // `with_scripted_owners` fails unless each unrelated app got exactly its one lookup.
        let listed = with_scripted_owners(&UNRELATED_APPS, &owners, async |client| {
            client.list_roots(Some(&[25361])).await.map(|roots| {
                roots
                    .iter()
                    .map(|root| (root.pid, executable_name(root).map(str::to_owned)))
                    .collect::<Vec<_>>()
            })
        })
        .await;
        assert_eq!(
            listed.map_err(|error| error.code),
            Ok(vec![(25361, Some("fixture-editor".to_owned()))])
        );
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
                    parent: None,
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
                                parent: None,
                            },
                        )?
                        .serve_at(
                            "/app",
                            TreeNode {
                                name: "Editor",
                                role: "application",
                                children: &[(":1.42", "/app/window")],
                                has_text: false,
                                parent: None,
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
                            parent: None,
                        },
                    )?
                    .serve_at(
                        "/window/label",
                        TreeNode {
                            name: "label",
                            role: "label",
                            children: &[],
                            has_text: false,
                            parent: Some((":1.42", "/window")),
                        },
                    )?
                    .serve_at(
                        "/foreign",
                        TreeNode {
                            name: "foreign secret",
                            role: "label",
                            children: &[],
                            has_text: true,
                            parent: None,
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

    /// A child whose provider does not implement `Parent` (`UnknownProperty`) cannot confirm its
    /// `GetChildren` edge, so it is never read and its listing node is `truncated` (#1377).
    #[tokio::test]
    async fn snapshots_never_read_children_without_a_parent_link() {
        let orphan_text = TreeText::default();
        with_peer(
            |server| {
                server
                    .serve_at(
                        "/window",
                        TreeNode {
                            name: "frame",
                            role: "frame",
                            children: &[(":1.42", "/window/label"), (":1.42", "/window/orphan")],
                            has_text: false,
                            parent: None,
                        },
                    )?
                    .serve_at(
                        "/window/label",
                        TreeNode {
                            name: "label",
                            role: "label",
                            children: &[],
                            has_text: false,
                            parent: Some((":1.42", "/window")),
                        },
                    )?
                    .serve_at(
                        "/window/orphan",
                        TreeNode {
                            name: "orphan secret",
                            role: "label",
                            children: &[],
                            has_text: true,
                            parent: None,
                        },
                    )?
                    .serve_at("/window/orphan", orphan_text.clone())
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
                assert!(snapshot.nodes[0].unread, "the listing node is truncated");
                assert!(!snapshot.nodes[1].unread);
                assert!(orphan_text.0.lock().unwrap().is_empty());
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

    /// The script aliases `interpreter` reports for the argv `args`, joined with NULs.
    fn aliases_of(interpreter: Interpreter, args: &[&str]) -> Vec<String> {
        let mut cmdline = args.join("\0").into_bytes();
        cmdline.push(0);
        hosted_aliases(interpreter, &cmdline)
    }

    #[test]
    fn interpreters_are_named_by_their_exe_basename() {
        for name in ["python", "python3", "python3.12", "python2.7"] {
            assert_eq!(Interpreter::of(name), Some(Interpreter::Python), "{name}");
        }
        for name in [
            "python3.",
            "python.3",
            "python3..1",
            "pythonw",
            "python3-config",
        ] {
            assert_eq!(Interpreter::of(name), None, "{name}");
        }
        assert_eq!(Interpreter::of("node"), Some(Interpreter::Node));
        assert_eq!(Interpreter::of("nodejs"), Some(Interpreter::Node));
        assert_eq!(Interpreter::of("java"), Some(Interpreter::Java));
        assert_eq!(Interpreter::of("gjs"), Some(Interpreter::Gjs));
        assert_eq!(Interpreter::of("gjs-console"), Some(Interpreter::Gjs));
        for name in ["KeePassXC", "bash", "electron", "perl"] {
            assert_eq!(Interpreter::of(name), None, "{name}");
        }
    }

    #[test]
    fn script_aliases_read_only_the_run_target() {
        use Interpreter::{Gjs, Java, Node, Python};
        let names = |names: &[&str]| {
            names
                .iter()
                .map(|&name| name.to_owned())
                .collect::<Vec<_>>()
        };
        let none: Vec<String> = Vec::new();
        let cases: &[(Interpreter, &[&str], Vec<String>)] = &[
            // The script's basename and stem, never a later app argument.
            (
                Python,
                &["python3", "-u", "/opt/tool.py", "--token", "secret"],
                names(&["tool.py", "tool"]),
            ),
            (
                Python,
                &["python3", "-W", "ignore", "tool"],
                names(&["tool"]),
            ),
            (
                Python,
                &["python3", "-Wignore", "-X", "dev", "a/b.pyw"],
                names(&["b.pyw", "b"]),
            ),
            (
                Python,
                &["python3", "-m", "pkg.tool", "x.py"],
                names(&["pkg.tool"]),
            ),
            (
                Python,
                &["python3", "--", "-dash.py"],
                names(&["-dash.py", "-dash"]),
            ),
            (Python, &["python3", "-OO", "--", "--"], names(&["--"])),
            // Inline code, stdin, help, an unknown option or a missing value: no alias.
            (Python, &["python3", "-c", "import tool"], none.clone()),
            (Python, &["python3", "-", "tool.py"], none.clone()),
            (Python, &["python3", "-h"], none.clone()),
            (
                Python,
                &["python3", "-Q", "secret", "tool.py"],
                none.clone(),
            ),
            (Python, &["python3", "-m"], none.clone()),
            (Python, &["python3", "-m", "pkg/tool"], none.clone()),
            (Python, &["python3", "-u"], none.clone()),
            (Python, &["python3"], none.clone()),
            (Python, &["python3", "/opt/"], none.clone()),
            (Python, &["python3", ".."], none.clone()),
            (Python, &["python3", "tool\u{7}.py"], none.clone()),
            (Python, &["python3", ".py"], names(&[".py"])),
            (
                Node,
                &[
                    "node",
                    "--max-old-space-size=4096",
                    "--inspect",
                    "/app/main.js",
                ],
                names(&["main.js", "main"]),
            ),
            (
                Node,
                &["node", "-r", "dotenv/config", "srv.mjs"],
                names(&["srv.mjs", "srv"]),
            ),
            (Node, &["node", "-e", "run()"], none.clone()),
            (Node, &["node", "--eval", "run()"], none.clone()),
            // Inline code in a long `=` option is code, not a flag: the next token is argv.
            (Node, &["node", "--eval=run()", "main.js"], none.clone()),
            (Node, &["node", "--print=1", "main.js"], none.clone()),
            // A known value option's `=` form is whole; an unknown `=` option stops.
            (
                Node,
                &["node", "--require=x.js", "app.js", "secretArg"],
                names(&["app.js", "app"]),
            ),
            (
                Node,
                &["node", "--inspect=9229", "app.js"],
                names(&["app.js", "app"]),
            ),
            (Node, &["node", "--unknown=x", "secretArg"], none.clone()),
            (
                Node,
                &["node", "--no-warnings=x", "secretArg"],
                none.clone(),
            ),
            (
                Node,
                &["node", "--unknown", "secret", "main.js"],
                none.clone(),
            ),
            (
                Java,
                &[
                    "java",
                    "-Xmx1g",
                    "-Dk=v",
                    "-cp",
                    "/lib/*",
                    "org.example.Main",
                    "--key",
                ],
                names(&["org.example.Main"]),
            ),
            (
                Java,
                &["java", "-jar", "/opt/KeePass.jar", "--secret"],
                names(&["KeePass.jar", "KeePass"]),
            ),
            (
                Java,
                &["java", "--module", "app.mod/app.Main"],
                names(&["app.mod", "app.Main"]),
            ),
            (
                Java,
                &["java", "--add-opens=a/b=ALL", "-m", "app.mod"],
                names(&["app.mod"]),
            ),
            (
                Java,
                &["java", "--module=app.mod/app.Main", "secretArg"],
                names(&["app.mod", "app.Main"]),
            ),
            (
                Java,
                &["java", "--add-opens=a/b=ALL-UNNAMED", "Main", "secretArg"],
                names(&["Main"]),
            ),
            (
                Java,
                &["java", "--enable-preview=x", "secretArg"],
                none.clone(),
            ),
            (Java, &["java", "--module="], none.clone()),
            // Source-file mode: the basename and stem, from a bare or a full path.
            (
                Java,
                &["java", "Tool.java", "secretArg"],
                names(&["Tool.java", "Tool"]),
            ),
            (
                Java,
                &["java", "--source", "21", "/opt/Tool.java"],
                names(&["Tool.java", "Tool"]),
            ),
            (Java, &["java", "-m", "a/b/c"], none.clone()),
            (Java, &["java", "-m", "a/"], none.clone()),
            (Java, &["java", "@argfile"], none.clone()),
            (Java, &["java", "/opt/Main"], none.clone()),
            (Java, &["java", "-jar"], none.clone()),
            (Java, &["java", "-version"], none.clone()),
            (
                Gjs,
                &["gjs", "-m", "-I", "/lib", "/usr/share/org.example.Tool.js"],
                names(&["org.example.Tool.js", "org.example.Tool"]),
            ),
            (Gjs, &["gjs", "-c", "print(1)"], none.clone()),
            (Gjs, &["gjs", "--command=print(1)", "x.js"], none.clone()),
            (
                Gjs,
                &["gjs", "--include-path=/lib", "app.js"],
                names(&["app.js", "app"]),
            ),
            (Gjs, &["gjs", "--module=x", "secretArg"], none.clone()),
            (
                Python,
                &["python3", "--check-hash-based-pycs=always", "tool.py"],
                names(&["tool.py", "tool"]),
            ),
            (Python, &["python3", "--help=x", "secretArg"], none.clone()),
        ];
        for (interpreter, args, expected) in cases {
            assert_eq!(&aliases_of(*interpreter, args), expected, "{args:?}");
        }
        // The alias is bounded; a non-UTF-8 token before the target is unreadable.
        let long = format!("{}.py", "t".repeat(MAX_SCRIPT_ALIAS_BYTES));
        assert_eq!(aliases_of(Python, &["python3", &long]), none);
        let stem = "t".repeat(MAX_SCRIPT_ALIAS_BYTES - 3);
        assert_eq!(
            aliases_of(Python, &["python3", &format!("{stem}.py")]),
            names(&[&format!("{stem}.py"), &stem])
        );
        assert_eq!(hosted_aliases(Python, b"python3\0-u\0\xff.py\0"), none);
        assert_eq!(
            hosted_aliases(Python, b"python3\0-W\0\xff\0tool.py\0"),
            names(&["tool.py", "tool"])
        );
        // A rewritten title is one token: no argv to read.
        assert_eq!(hosted_aliases(Python, b"python3 tool.py"), none);
    }

    #[test]
    fn process_executable_adds_interpreter_script_aliases() {
        let fixture = ProcFixture::new(&[
            (20, "/usr/bin/python3.12"),
            (21, "/usr/bin/KeePassXC"),
            (22, "/usr/bin/python3"),
            (23, "/usr/bin/python3"),
            (24, "/usr/bin/python3"),
            (25, "/usr/bin/python3"),
            (26, "/usr/bin/python3"),
            (27, "/usr/bin/node (deleted)"),
        ]);
        let proc = fixture.0.as_path();
        let cmdline = |pid: u64| proc.join(pid.to_string()).join("cmdline");
        std::fs::write(cmdline(20), b"python3\0/opt/tool.py\0--token\0secret\0").unwrap();
        std::fs::write(cmdline(21), b"python3\0/opt/tool.py\0").unwrap();
        // 22 has no cmdline: the identity stands, with no alias.
        std::os::unix::fs::symlink(cmdline(20), cmdline(23)).unwrap();
        std::fs::create_dir(cmdline(24)).unwrap();
        // A target past the read cap is cut, so no partial name becomes an alias.
        let mut cut = b"python3\0-W\0".to_vec();
        cut.resize(MAX_CMDLINE_BYTES - 4, b'x');
        cut.extend_from_slice(b"\0tool.py\0");
        std::fs::write(cmdline(25), &cut).unwrap();
        // A target before the cap is kept however long the argv after it.
        let mut long = b"python3\0tool.py\0".to_vec();
        long.resize(MAX_CMDLINE_BYTES * 2, b'x');
        std::fs::write(cmdline(26), &long).unwrap();
        std::fs::write(cmdline(27), b"node\0main.js\0").unwrap();

        let aliases =
            |pid| process_executable(proc, pid).map(|executable| executable.script_aliases);
        assert_eq!(aliases(20), Some(vec!["tool.py".into(), "tool".into()]));
        assert_eq!(process_executable(proc, 20).unwrap().name, "python3.12");
        assert_eq!(aliases(21), Some(Vec::new()), "not an interpreter");
        for pid in [22, 23, 24, 25] {
            assert_eq!(aliases(pid), Some(Vec::new()), "pid {pid}");
        }
        assert_eq!(aliases(26), Some(vec!["tool.py".into(), "tool".into()]));
        let node = process_executable(proc, 27).unwrap();
        assert_eq!(node.name, "node");
        assert_eq!(
            node.block_aliases(),
            vec!["node (deleted)", "main.js", "main"]
        );
    }
}
