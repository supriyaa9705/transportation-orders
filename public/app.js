async function loadOrders() {
  const res = await fetch("/api/orders");
  const orders = await res.json();
  const tbody = document.getElementById("orders-body");
  tbody.innerHTML = "";
  orders.forEach(o => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.order_id}</td>
      <td>${o.customer_name || "-"}</td>
      <td>${o.origin || "-"}</td>
      <td>${o.destination || "-"}</td>
      <td>${o.status}</td>
      <td>
        <button onclick="report(${o.order_id})">Report</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

async function createOrder() {
  await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: "ACME Logistics",
      origin: "Sydney",
      destination: "Newcastle",
      status: "In Transit"
    })
  });
  loadOrders();
}

async function report(id) {
  const res = await fetch(`/api/orders/${id}/report`);
  const j = await res.json();
  if (j.downloadUrl) window.open(j.downloadUrl, "_blank");
  else alert("Report not ready");
}

document.getElementById("btn-refresh").onclick = loadOrders;
document.getElementById("btn-create").onclick = createOrder;

document.getElementById("btn-upload").onclick = async () => {
  const id = document.getElementById("orderIdUpload").value;
  const file = document.getElementById("fileInput").files[0];
  if (!id || !file) return alert("Provide Order ID and file.");

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch(`/api/orders/${id}/upload`, { method: "POST", body: fd });
  const j = await res.json();
  if (j.uploaded) alert("Uploaded to " + j.s3Uri);
  else alert("Upload failed");
};

loadOrders();
