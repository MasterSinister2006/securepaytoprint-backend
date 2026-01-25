// backend/server.js
// ================= PRINTER FROM QR =================
const urlParams = new URLSearchParams(window.location.search);
const selectedPrinter = urlParams.get("printer") || "SOS";

console.log("Connected to printer:", selectedPrinter);

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const upload = require("./uploadHandler");
const db = require("./database");
const { addToQueue } = require("./printQueue");

const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const ADMIN_PHONE = "9974151674";
const MAX_USER_PAGES = 20;

// =================================================
// PAGE COUNT API
// =================================================
app.post("/count-pages", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      fs.unlinkSync(filePath);
      return res.json({ pages: data.numpages });
    }

    if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      fs.unlinkSync(filePath);
      return res.json({ pages: 1 });
    }

    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      const words = result.value.split(/\s+/).length;
      const pages = Math.max(1, Math.ceil(words / 350));
      fs.unlinkSync(filePath);
      return res.json({ pages });
    }

    if (ext === ".xlsx") {
      const workbook = XLSX.readFile(filePath);
      const sheets = workbook.SheetNames.length;
      fs.unlinkSync(filePath);
      return res.json({ pages: sheets });
    }

    fs.unlinkSync(filePath);
    res.status(400).json({ error: "Unsupported file type" });

  } catch (err) {
    console.error("PAGE COUNT ERROR:", err);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: "Page counting failed" });
  }
});

// =================================================
// TOKEN GENERATOR
// =================================================
function generateToken() {
  return Math.random().toString(16).substring(2, 8).toUpperCase();
}

// =================================================
// PRINT UPLOAD + PRINTER RESOURCE MANAGEMENT
// =================================================
app.post("/upload", upload.single("file"), (req, res) => {

  const { phone, pages, print_type, amount, isAdmin, force } = req.body;
  const printer_id = req.query.printer || "SOS";

  const token = generateToken();
  const totalPages = Number(pages);
  const admin = isAdmin === "true" || isAdmin === true;

  // User limit
  if (!admin && totalPages > MAX_USER_PAGES) {
    return res.status(400).json({
      error: "Normal users can print only 20 pages at a time."
    });
  }

  // Get printer status
  db.get(
    "SELECT * FROM PrinterStatus WHERE printer_id = ?",
    [printer_id],
    (err, printer) => {

      if (err || !printer) {
        return res.status(500).json({ error: "Printer not found" });
      }

      const availablePaper = printer.paper;

      // Paper shortage warning
      if (!admin && availablePaper < totalPages && !force) {
        return res.json({
          warning: true,
          available: availablePaper,
          message: `Only ${availablePaper} pages are available. Last ${totalPages - availablePaper} pages will NOT be printed. Do you want to continue?`
        });
      }

      // Pages actually printed
      const pagesToPrint = admin
        ? totalPages
        : Math.min(totalPages, availablePaper);

      // Ink usage calculation
      let blackInkUsed = 0;
      let colorInkUsed = 0;

      if (print_type === "bw") {
        blackInkUsed = pagesToPrint * 0.3;
      } else {
        blackInkUsed = pagesToPrint * 0.2;
        colorInkUsed = pagesToPrint * 0.4;
      }

      const newBlackInk = Math.max(0, printer.black_ink - blackInkUsed);
      const newColorInk = Math.max(0, printer.color_ink - colorInkUsed);
      const newPaper = Math.max(0, printer.paper - pagesToPrint);

      // Update printer resources
      db.run(
        `UPDATE PrinterStatus 
         SET black_ink = ?, color_ink = ?, paper = ?
         WHERE printer_id = ?`,
        [newBlackInk, newColorInk, newPaper, printer_id],
        err => {
          if (err) {
            console.error("PrinterStatus update error:", err);
            return res.status(500).json({ error: "Failed to update printer status" });
          }

          // Save print log
          db.run(
            `INSERT INTO PrintLogs(token, phone, printer_id, pages, print_type, amount, time)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [token, phone, printer_id, pagesToPrint, print_type, amount],
            err => {
              if (err) {
                console.error("PrintLogs insert error:", err);
                return res.status(500).json({ error: "Database error" });
              }

              // Reverse printing simulation
              console.log(`\n🖨 Printing on ${printer_id} (Reverse Order):`);
              for (let i = pagesToPrint; i >= 1; i--) {
                console.log(`Printing page ${i}`);
              }

              addToQueue({
                token,
                printer_id,
                filePath: req.file.path
              });

              res.json({
                success: true,
                token,
                printedPages: pagesToPrint,
                remainingPaper: newPaper,
                remainingBlackInk: newBlackInk.toFixed(1),
                remainingColorInk: newColorInk.toFixed(1)
              });
            }
          );
        }
      );
    }
  );
});

// =================================================
// ADMIN: PRINTER STATUS
// =================================================
app.get("/admin/printer-status", (req, res) => {
  db.all("SELECT * FROM PrinterStatus", [], (err, rows) => {
    if (err) {
      console.error("PrinterStatus fetch error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(rows);
  });
});

// =================================================
// ADMIN: ORDERS TABLE (DATE FILTER)
// =================================================
app.get("/admin/orders", (req, res) => {
  const date = req.query.date;

  const q = `
    SELECT token, phone, printer_id, pages, print_type, amount, time,
           date(time) as date_only
    FROM PrintLogs
    WHERE date(time) = ?
    ORDER BY time DESC
  `;

  db.all(q, [date], (err, rows) => {
    if (err) {
      console.error("Orders fetch error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(rows);
  });
});

// =================================================
// ADMIN: SUMMARY APIs
// =================================================
app.get("/admin/summary/today", (req, res) => {
  const q = `
    SELECT printer_id, IFNULL(SUM(amount),0) as revenue
    FROM PrintLogs
    WHERE date(time) = date('now')
    GROUP BY printer_id
  `;
  db.all(q, [], (err, rows) => res.json(rows || []));
});

app.get("/admin/summary/month", (req, res) => {
  const q = `
    SELECT printer_id, IFNULL(SUM(amount),0) as revenue
    FROM PrintLogs
    WHERE strftime('%Y-%m', time) = strftime('%Y-%m','now')
    GROUP BY printer_id
  `;
  db.all(q, [], (err, rows) => res.json(rows || []));
});

app.get("/admin/usage", (req, res) => {
  const q = `
    SELECT printer_id,
           SUM(pages) as total_pages,
           SUM(CASE WHEN print_type='bw' THEN pages ELSE 0 END) as bw_pages,
           SUM(CASE WHEN print_type='color' THEN pages ELSE 0 END) as color_pages
    FROM PrintLogs
    GROUP BY printer_id
  `;
  db.all(q, [], (err, rows) => res.json(rows || []));
});

app.get("/admin/top-printer", (req, res) => {
  db.get(
    `SELECT printer_id, SUM(pages) as total
     FROM PrintLogs GROUP BY printer_id
     ORDER BY total DESC LIMIT 1`,
    [],
    (err, row) => res.json(row || {})
  );
});

app.get("/admin/least-printer", (req, res) => {
  db.get(
    `SELECT printer_id, SUM(pages) as total
     FROM PrintLogs GROUP BY printer_id
     ORDER BY total ASC LIMIT 1`,
    [],
    (err, row) => res.json(row || {})
  );
});

// =================================================
// SERVER START
// =================================================
app.listen(3000, () => {
  console.log("======================================");
  console.log("Server running at http://localhost:3000");
  console.log("Admin Dashboard → /admin.html");
  console.log("Admin Phone Override:", ADMIN_PHONE);
  console.log("======================================");
});
