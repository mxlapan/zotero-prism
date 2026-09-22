const toggle = document.getElementById("toggle");
const status = document.getElementById("status");
const endpoint = document.getElementById("endpoint");

async function refresh() {
  const info = await chrome.runtime.sendMessage({ type: "prism-status" });
  endpoint.value = info.endpoint || "";
  if (info.connected) {
    status.textContent = `Connected — ${info.target}${info.busy ? " · answering" : ""}`;
    toggle.textContent = "Disconnect";
    toggle.classList.add("secondary");
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
  } else {
    await chrome.runtime.sendMessage({ type: "prism-endpoint", endpoint: endpoint.value.trim() });
    const result = await chrome.runtime.sendMessage({ type: "prism-connect" });
    if (!result?.ok) status.textContent = `Failed: ${result?.error || "unknown"}`;
  }
  setTimeout(refresh, 300);
});

endpoint.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "prism-endpoint", endpoint: endpoint.value.trim() }),
);

refresh();
setInterval(refresh, 2000);
