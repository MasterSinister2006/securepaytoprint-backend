// backend/enhanced-server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
  fileFilter: (req, file, cb) => {
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  }
});

// Session storage
global.sessions = {};

// =================================================
// CREATE SESSION (Enhanced with page selection)
// =================================================
app.post("/create-session", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileName = req.file.originalname;
    
    // Verify file is valid
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Empty file" });
    }

    // Count total pages in file
    let totalPagesInFile = 0;
    
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      totalPagesInFile = data.numpages || 0;
    } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      totalPagesInFile = 1;
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      const words = result.value.trim().split(/\s+/).length;
      totalPagesInFile = words === 0 ? 0 : Math.ceil(words / 350);
    } else if (ext === ".xlsx") {
      const workbook = XLSX.readFile(filePath);
      totalPagesInFile = workbook.SheetNames.length;
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Unsupported file type" });
    }

    // Create session
    const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();

    global.sessions[sessionId] = {
      sessionId,
      fileName,
      filePath,
      fileType: ext,
      totalPagesInFile,
      selectedPages: [], // Will be set by machine
      pageSettings: {},
      printMode: 'single',
      copies: 1,
      totalAmount: 0,
      paymentStatus: "PENDING",
      printStatus: "WAITING",
      createdAt: new Date()
    };

    console.log("✅ New session created:", {
      sessionId,
      fileName,
      totalPages: totalPagesInFile,
      fileType: ext
    });

    // Return page count to phone
    res.json({ 
      sessionId, 
      pages: totalPagesInFile,
      fileName
    });
    
  } catch (err) {
    console.error("❌ Error creating session:", err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// =================================================
// UPDATE SESSION (Machine updates with page selection and settings)
// =================================================
app.post("/update-session", (req, res) => {
  const { sessionId, selectedPages, pageSettings, printMode, copies, totalAmount } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  // Update session with machine settings
  session.selectedPages = selectedPages;
  session.pageSettings = pageSettings;
  session.printMode = printMode;
  session.copies = copies;
  session.totalAmount = totalAmount;
  session.updatedAt = new Date();

  console.log(`📝 Session updated: ${sessionId}`, {
    selectedPages: selectedPages.length,
    totalAmount,
    printMode,
    copies
  });

  res.json({ success: true, sessionId });
});

// =================================================
// GET FILE (for frontend to access uploaded file)
// =================================================
app.get("/get-file/:sessionId", (req, res) => {
  const session = global.sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  if (!fs.existsSync(session.filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  
  res.sendFile(path.resolve(session.filePath));
});

// =================================================
// GET PAGE PREVIEW (for rendering on machine)
// =================================================
app.get("/session/:id/page/:pageNum", async (req, res) => {
  const session = global.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  const pageNum = parseInt(req.params.pageNum);
  const ext = session.fileType;
  
  try {
    if (ext === '.pdf') {
      // For PDF, we'll return the file path for the frontend to render
      res.json({ 
        type: 'pdf',
        filePath: session.filePath,
        pageNum: pageNum
      });
    } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      // For images, send the image file directly
      res.sendFile(path.resolve(session.filePath));
    } else {
      res.json({ type: 'placeholder' });
    }
  } catch (err) {
    console.error("Error getting page preview:", err);
    res.status(500).json({ error: "Error generating preview" });
  }
});

// =================================================
// GET SESSION INFO
// =================================================
app.get("/session/:id", (req, res) => {
  const session = global.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  // Return session data without file path (security)
  const { filePath, ...sessionData } = session;
  res.json(sessionData);
});

// =================================================
// PAYMENT CONFIRMATION
// =================================================
app.post("/confirm-payment", (req, res) => {
  const { sessionId, amount } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  // Verify amount matches
  if (parseInt(amount) !== session.totalAmount) {
    return res.status(400).json({ error: "Amount mismatch" });
  }

  // TODO: Real payment verification here
  // - Verify with payment gateway (Razorpay/Stripe/UPI)
  // - Confirm transaction ID
  // - Check payment status

  session.paymentStatus = "PAID";
  session.paidAt = new Date();
  
  console.log(`💰 Payment confirmed for session ${sessionId}: ₹${amount}`);

  res.json({ 
    success: true,
    sessionId,
    amount
  });
});

// =================================================
// START PRINTING
// =================================================
app.post("/start-print", async (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });
  
  if (session.paymentStatus !== "PAID") {
    return res.status(400).json({ error: "Payment not confirmed" });
  }

  session.printStatus = "PRINTING";
  session.printStartedAt = new Date();

  console.log(`🖨️  Printing started for session ${sessionId}:`, {
    file: session.fileName,
    pages: session.selectedPages.length,
    copies: session.copies,
    mode: session.printMode
  });

  // TODO: Real printer integration
  // - Send file to printer driver
  // - Apply page selection (print only selected pages)
  // - Apply color settings per page
  // - Apply single/double sided setting
  // - Apply number of copies
  // - Wait for printer acknowledgment

  /* Example printer command structure:
  {
    file: session.filePath,
    pages: session.selectedPages, // e.g., [1, 3, 5]
    colorPages: Object.keys(session.pageSettings)
      .filter(p => session.pageSettings[p].color === 'color')
      .map(Number), // e.g., [1, 5]
    duplex: session.printMode === 'double',
    copies: session.copies
  }
  */

  res.json({ 
    success: true,
    pages: session.selectedPages.length,
    copies: session.copies,
    mode: session.printMode
  });
});

// =================================================
// FINISH PRINTING
// =================================================
app.post("/finish-print", (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  session.printStatus = "DONE";
  session.completedAt = new Date();

  // Delete file for security
  if (fs.existsSync(session.filePath)) {
    fs.unlinkSync(session.filePath);
    console.log(`🗑️  File deleted: ${session.fileName}`);
  }

  console.log(`✅ Printing completed for session ${sessionId}`);

  res.json({ success: true });
});

// =================================================
// ADMIN - VIEW ALL SESSIONS
// =================================================
app.get("/admin/sessions", (req, res) => {
  const sessions = Object.values(global.sessions).map(session => {
    const { filePath, ...sessionData } = session;
    return sessionData;
  });
  res.json(sessions);
});

app.get("/admin/stats", async (req, res) => {
  try {
    const orders = await db.collection("orders").find().toArray();
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
    res.json({ totalOrders, totalRevenue, activePrinters: 1 });
  } catch (err) {
    res.status(500).send("Error fetching stats");
  }
});

// =================================================
// CANCEL SESSION (New feature)
// =================================================
app.post("/cancel-session", (req, res) => {
  const { sessionId } = req.body;
  const session = global.sessions[sessionId];

  if (!session) return res.status(404).json({ error: "Session not found" });

  // Delete file if exists
  if (fs.existsSync(session.filePath)) {
    fs.unlinkSync(session.filePath);
  }

  delete global.sessions[sessionId];
  
  console.log(`❌ Session cancelled: ${sessionId}`);
  
  res.json({ success: true });
});

// =================================================
// CLEANUP OLD SESSIONS (Auto-cleanup after 1 hour)
// =================================================
setInterval(() => {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  
  Object.keys(global.sessions).forEach(sessionId => {
    const session = global.sessions[sessionId];
    if (session.createdAt < oneHourAgo && session.printStatus !== "PRINTING") {
      // Delete file
      if (fs.existsSync(session.filePath)) {
        fs.unlinkSync(session.filePath);
      }
      delete global.sessions[sessionId];
      console.log(`🧹 Auto-cleaned old session: ${sessionId}`);
    }
  });
}, 10 * 60 * 1000); // Run every 10 minutes

// =================================================
// SERVER START
// =================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("========================================");
  console.log(`✅ Enhanced SecurePayToPrint Server`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`📄 Features: Page preview, selection, per-page settings`);
  console.log(`🖨️  Print modes: Single/Double sided`);
  console.log("========================================");
});

module.exports = app;