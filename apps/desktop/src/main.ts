import { invoke } from "@tauri-apps/api/core";

import bootstrapCommand from "./bootstrap-command.txt?raw";
import { formatNanoseconds, parseBootstrapProbe } from "./bootstrap-contract";
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Bootstrap shell is missing its app root.");
}

app.innerHTML = `
  <main class="probe-shell">
    <section class="probe-panel" aria-labelledby="probe-title">
      <p class="eyebrow">WP-0.2 · benchmark-only</p>
      <h1 id="probe-title">MeetingRelay bootstrap probe</h1>
      <p id="probe-disclaimer" class="disclaimer">
        This checks only the desktop-to-Rust bootstrap contract. It does not
        provide session, audio, ASR, or translation functionality.
      </p>

      <button id="probe-button" type="button" aria-describedby="probe-disclaimer">
        Run bootstrap probe
      </button>

      <p id="probe-status" class="status" role="status" aria-live="polite">
        Ready to run.
      </p>

      <dl id="probe-results" class="results" hidden>
        <div>
          <dt>Contract version</dt>
          <dd id="contract-version"></dd>
        </div>
        <div>
          <dt>Worker</dt>
          <dd id="worker-duration"></dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd id="output-duration"></dd>
        </div>
        <div>
          <dt>End to end</dt>
          <dd id="end-to-end-duration"></dd>
        </div>
      </dl>
    </section>
  </main>
`;

const probeButton = document.querySelector<HTMLButtonElement>("#probe-button");
const status = document.querySelector<HTMLParagraphElement>("#probe-status");
const results = document.querySelector<HTMLDListElement>("#probe-results");
const contractVersion = document.querySelector<HTMLElement>("#contract-version");
const workerDuration = document.querySelector<HTMLElement>("#worker-duration");
const outputDuration = document.querySelector<HTMLElement>("#output-duration");
const endToEndDuration = document.querySelector<HTMLElement>("#end-to-end-duration");

if (
  !probeButton ||
  !status ||
  !results ||
  !contractVersion ||
  !workerDuration ||
  !outputDuration ||
  !endToEndDuration
) {
  throw new Error("Bootstrap probe controls are incomplete.");
}

function conciseErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const conciseMessage = message.trim().replace(/\s+/g, " ").slice(0, 160);

  if (conciseMessage.length === 0) {
    return "Unknown IPC error.";
  }

  return conciseMessage;
}

const bootstrapCommandName = bootstrapCommand.trim();

probeButton.addEventListener("click", async () => {
  probeButton.disabled = true;
  results.hidden = true;
  status.dataset.state = "pending";
  status.textContent = "Running bootstrap probe…";

  try {
    const response = await invoke<unknown>(bootstrapCommandName);
    const probe = parseBootstrapProbe(response);

    contractVersion.textContent = probe.contractVersion;
    workerDuration.textContent = formatNanoseconds(probe.workerNs);
    outputDuration.textContent = formatNanoseconds(probe.outputNs);
    endToEndDuration.textContent = formatNanoseconds(probe.endToEndNs);
    results.hidden = false;
    status.dataset.state = "success";
    status.textContent = "Bootstrap probe completed.";
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `Bootstrap probe failed: ${conciseErrorMessage(error)}`;
  } finally {
    probeButton.disabled = false;
  }
});
