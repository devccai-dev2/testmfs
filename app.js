const input = document.getElementById("pdf-input");
const extractButton = document.getElementById("extract-btn");
const downloadButton = document.getElementById("download-btn");
const statusEl = document.getElementById("status");
const tableHead = document.querySelector("#data-table thead");
const tableBody = document.querySelector("#data-table tbody");

const defaultColumns = [
  "Date & Time",
  "Transaction Type",
  "Transaction Details",
  "Out",
  "In",
  "Charge/Fee",
  "Balance",
];

let loadedPdf = null;
let extractedRows = [];
let pdfjsReadyPromise = null;

const ensurePdfJsReady = async () => {
  if (!pdfjsReadyPromise) {
    if (window.pdfjsReady) {
      pdfjsReadyPromise = window.pdfjsReady;
    } else if (window.pdfjsLib) {
      pdfjsReadyPromise = Promise.resolve(window.pdfjsLib);
    } else {
      pdfjsReadyPromise = Promise.reject(
        new Error("PDF.js failed to load. Check your network or CDN access.")
      );
    }
  }

  return pdfjsReadyPromise;
};

const updateStatus = (message) => {
  statusEl.textContent = message;
};

const clearTable = () => {
  tableHead.innerHTML = "";
  tableBody.innerHTML = "";
};

const renderTable = (columns, rows) => {
  clearTable();
  const headerRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column;
    headerRow.appendChild(th);
  });
  tableHead.appendChild(headerRow);

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((column) => {
      const td = document.createElement("td");
      td.textContent = row[column] ?? "";
      tr.appendChild(td);
    });
    tableBody.appendChild(tr);
  });
};

const downloadCsv = (columns, rows) => {
  const escapeCell = (value) => {
    const text = value ?? "";
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
  };

  const csvLines = [
    columns.map(escapeCell).join(","),
    ...rows.map((row) => columns.map((col) => escapeCell(row[col])).join(",")),
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "statement-extracted.csv";
  anchor.click();
  URL.revokeObjectURL(url);
};

const groupTextByLine = (items) => {
  const lineBuckets = new Map();
  items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    if (!lineBuckets.has(y)) {
      lineBuckets.set(y, []);
    }
    lineBuckets.get(y).push(item);
  });

  const lines = Array.from(lineBuckets.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, lineItems]) =>
      lineItems.sort((a, b) => a.transform[4] - b.transform[4])
    );

  return lines;
};

const findColumnAnchors = (lines) => {
  const headerLine = lines.find((line) =>
    line.some((item) =>
      item.str.toLowerCase().includes("transaction")
    )
  );

  if (!headerLine) {
    return null;
  }

  const headerText = headerLine.map((item) => item.str.trim()).join(" ");
  if (!headerText.toLowerCase().includes("date")) {
    return null;
  }

  const anchors = {};
  headerLine.forEach((item) => {
    const text = item.str.trim().toLowerCase();
    if (text.startsWith("date")) {
      anchors.date = item.transform[4];
    }
    if (text.startsWith("transaction") && text.includes("type")) {
      anchors.type = item.transform[4];
    }
    if (text.startsWith("transaction") && text.includes("details")) {
      anchors.details = item.transform[4];
    }
    if (text === "out") {
      anchors.out = item.transform[4];
    }
    if (text === "in") {
      anchors.in = item.transform[4];
    }
    if (text.includes("charge")) {
      anchors.charge = item.transform[4];
    }
    if (text.includes("balance")) {
      anchors.balance = item.transform[4];
    }
  });

  const requiredKeys = ["date", "type", "details", "out", "in", "charge", "balance"];
  const hasAll = requiredKeys.every((key) => key in anchors);
  return hasAll ? anchors : null;
};

const assignToColumns = (items, anchors) => {
  const sortedItems = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  const columns = {
    "Date & Time": "",
    "Transaction Type": "",
    "Transaction Details": "",
    Out: "",
    In: "",
    "Charge/Fee": "",
    Balance: "",
  };

  sortedItems.forEach((item) => {
    const x = item.transform[4];
    const text = item.str.trim();
    if (!text) {
      return;
    }

    if (x >= anchors.balance) {
      columns.Balance = `${columns.Balance} ${text}`.trim();
    } else if (x >= anchors.charge) {
      columns["Charge/Fee"] = `${columns["Charge/Fee"]} ${text}`.trim();
    } else if (x >= anchors.in) {
      columns.In = `${columns.In} ${text}`.trim();
    } else if (x >= anchors.out) {
      columns.Out = `${columns.Out} ${text}`.trim();
    } else if (x >= anchors.details) {
      columns["Transaction Details"] = `${columns["Transaction Details"]} ${text}`.trim();
    } else if (x >= anchors.type) {
      columns["Transaction Type"] = `${columns["Transaction Type"]} ${text}`.trim();
    } else {
      columns["Date & Time"] = `${columns["Date & Time"]} ${text}`.trim();
    }
  });

  return columns;
};

const extractTableFromPdf = async (pdf) => {
  updateStatus("Reading PDF…");
  const totalPages = pdf.numPages;
  const allRows = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = groupTextByLine(content.items);
    const anchors = findColumnAnchors(lines);

    if (!anchors) {
      updateStatus("Could not detect table columns. Try another PDF or adjust layout.");
      return [];
    }

    const headerIndex = lines.findIndex((line) =>
      line.some((item) => item.str.toLowerCase().includes("date"))
    );

    const dataLines = lines.slice(headerIndex + 1).filter((line) => {
      const combined = line.map((item) => item.str).join(" ").toLowerCase();
      return combined.includes("trx") || /\d{2}-[a-z]{3}-\d{2}/i.test(combined);
    });

    dataLines.forEach((line) => {
      const row = assignToColumns(line, anchors);
      if (row["Date & Time"] || row["Transaction Type"] || row["Transaction Details"]) {
        allRows.push(row);
      }
    });
  }

  return allRows;
};

input.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  try {
    updateStatus("Loading PDF…");
    const pdfjsLib = await ensurePdfJsReady();
    if (!pdfjsLib) {
      updateStatus("PDF.js failed to load. Check your network and refresh.");
      return;
    }
    const arrayBuffer = await file.arrayBuffer();
    loadedPdf = await pdfjsLib
      .getDocument({ data: arrayBuffer, disableWorker: true })
      .promise;
    updateStatus(`Loaded ${file.name}. Ready to extract.`);
    extractButton.disabled = false;
  } catch (error) {
    updateStatus(error.message);
  }
});

extractButton.addEventListener("click", async () => {
  if (!loadedPdf) {
    return;
  }
  extractButton.disabled = true;
  updateStatus("Extracting rows…");
  extractedRows = await extractTableFromPdf(loadedPdf);
  renderTable(defaultColumns, extractedRows);
  updateStatus(`Extracted ${extractedRows.length} rows.`);
  downloadButton.disabled = extractedRows.length === 0;
  extractButton.disabled = false;
});

downloadButton.addEventListener("click", () => {
  if (extractedRows.length === 0) {
    return;
  }
  downloadCsv(defaultColumns, extractedRows);
});
