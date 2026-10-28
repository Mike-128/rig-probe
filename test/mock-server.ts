/**
 * Runs the mock gateway on a fixed port so the app can be tried without real credentials:
 *   npm run mock      (then, in another terminal)   npm start
 * It speaks both topologies and accepts the APIM subscription key "demo-key".
 */
import { startMock } from "./mock-anthropic";

const port = Number(process.env.RIG_PROBE_MOCK_PORT ?? 7879);
const anthropic = await startMock({ port, auth: { header: "Ocp-Apim-Subscription-Key", value: "demo-key" } });
const vertex = await startMock({ port: port + 1, dialect: "vertex", auth: { header: "Ocp-Apim-Subscription-Key", value: "demo-key" } });

console.log(`
  Mock gateway running. It imitates APIM in front of claude-opus-5-5. Nothing leaves this machine.

  Anthropic 1P > APIM   preset "Anthropic 1P via APIM"
    Base URL   ${anthropic.url}/anthropic
  Anthropic via GCP > APIM   preset "Google Vertex AI via APIM (Vertex routes)"
    Base URL   ${vertex.url}/vertex/v1      (any project ID and region)

  Model        claude-opus-5-5
  Key          demo-key   (header Ocp-Apim-Subscription-Key)

  Press Ctrl+C to stop.
`);
