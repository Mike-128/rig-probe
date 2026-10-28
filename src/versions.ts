import os from "node:os";
import { VERSION as SDK_VERSION } from "@anthropic-ai/sdk/version";
import { VERSION as VERTEX_VERSION } from "@anthropic-ai/vertex-sdk/version";

export const TOOL_NAME = "rig-probe";
export const TOOL_VERSION = "0.1.0";

export function environment() {
  return {
    tool: `${TOOL_NAME} ${TOOL_VERSION}`,
    anthropicSdk: SDK_VERSION,
    vertexSdk: VERTEX_VERSION,
    node: process.version,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
  };
}
