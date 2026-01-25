const multer = require("multer");
const path = require("path");
const fs = require("fs");

if (!fs.existsSync("temp_uploads")) {
  fs.mkdirSync("temp_uploads");
}

const storage = multer.diskStorage({
  destination: "temp_uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 800 * 1024 * 1024 }, // 800 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file type"), false);
    }
    cb(null, true);
  }
});

module.exports = upload;
