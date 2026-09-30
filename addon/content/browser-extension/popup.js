const toggle = document.getElementById("toggle");
const status = document.getElementById("status");
const endpoint = document.getElementById("endpoint");

/** The reason the last Connect attempt failed, kept on screen. */
let lastError = "";

async function refresh() {
  const info = await chrome.runtime.sendMessage({ type: "prism-status" });
  endpoint.value = info.endpoint || "";
  if (info.connected) {
    lastError = "";
    status.textContent = `Connected — ${info.target}${info.busy ? " · answering" : ""}`;
    toggle.textContent = "Disconnect";
    toggle.classList.add("secondary");
  } else if (lastError) {
    // Without this the poll below replaces the reason with the generic line
    // before it can be read.
    status.textContent = lastError;
    toggle.textContent = "Connect this tab";
    toggle.classList.remove("secondary");
  } else {
    status.textContent = "Not connected. Open a chat site and press Connect.";
    toggle.textContent = "Connect this tab";
    toggle.classList.remove("secondary");
  }
}

toggle.addEventListener("click", async () => {
  const info = await chrome.runtime.sendMessage({ type: "prism-status" });
  if (info.connected) {
    await chrome.runtime.sendMessage({ type: "prism-disconnect" });
    lastError = "";
  } else {
    await chrome.runtime.sendMessage({ type: "prism-endpoint", endpoint: endpoint.value.trim() });
    const result = await chrome.runtime.sendMessage({ type: "prism-connect" });
    lastError = result?.ok ? "" : `Failed: ${result?.error || "unknown"}`;
    if (lastError) status.textContent = lastError;
  }
  setTimeout(refresh, 300);
});

endpoint.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "prism-endpoint", endpoint: endpoint.value.trim() }),
);

refresh();
setInterval(refresh, 2000);
