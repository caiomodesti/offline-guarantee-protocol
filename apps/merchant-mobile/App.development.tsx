import { MerchantApplication } from "./App";
import { expectedEnvironment } from "./src/trust";

/** Historical Sprint 7 offline demonstration. It never enables claim submission. */
export default function DevelopmentApp() {
  return <MerchantApplication
    runtime={{
      trust: expectedEnvironment,
      merchant: new Uint8Array(32).fill(0x71),
      rpcUrl: "http://127.0.0.1:8899",
      relayerUrl: "http://127.0.0.1:8787",
    }}
    submissionEnabled={false}
  />;
}
