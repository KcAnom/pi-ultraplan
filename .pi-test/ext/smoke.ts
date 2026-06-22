import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "smoke_test",
    description: "Simple smoke test tool",
    parameters: Type.Object({ msg: Type.String({}) }),
    handler: async (params: any) => ({ echo: params.msg, ok: true }),
  });
}
