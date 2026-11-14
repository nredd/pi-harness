import { sandboxAgentDir } from "@nredd/pi-test-lib/sandbox";

export default function setup(): () => void {
  return sandboxAgentDir().restore;
}
