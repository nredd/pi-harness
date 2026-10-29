/** A child extension whose startup error must be reported without killing the child. */
export default function lifecycleSessionError(pi) {
  pi.on("session_start", () => { throw new Error("fixture session_start failed"); });
}
