require("dotenv").config();

const express = require("express");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const sharp = require("sharp");
const axios = require("axios");
const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const { Parser } = require("json2csv");
const nodemailer = require("nodemailer");
const cors = require("cors");
const app = express();
const prisma = new PrismaClient();

app.use(express.json());
// Health Check Route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "Backend is live 🚀" });
});
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use("/uploads", express.static("src/uploads"));

// ================= EMAIL SETUP =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ================= FILE UPLOAD =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "src/uploads"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});

const upload = multer({ storage });

// ================= AUTH MIDDLEWARE =================
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "No token" });

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "ADMIN")
    return res.status(403).json({ message: "Admin only" });
  next();
}

function authorityOnly(req, res, next) {
  if (req.user.role !== "AUTHORITY")
    return res.status(403).json({ message: "Authority only" });
  next();
}

// ================= DISTRICT DETECTION =================
async function getDistrictFromCoords(lat, lng) {
  try {
    const response = await axios.get("https://nominatim.openstreetmap.org/reverse", {
      params: {
        lat,
        lon: lng,
        format: "json",
        addressdetails: 1,
      },
      headers: { "User-Agent": "civic-app" },
    });

    const address = response.data.address;
    if (address.state !== "Tamil Nadu") return null;

    return address.state_district || address.county || address.city || null;
  } catch {
    return null;
  }
}

// ================= AUTH ROUTES =================

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (!user)
      return res.status(400).json({ message: "Invalid credentials" });

    if (user.role === "CITIZEN" && !user.emailVerified)
      return res.status(403).json({ message: "Please verify your email first" });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user.id, role: user.role, district: user.district },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ user, token });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Login failed" });
  }
});

// Citizen Signup - Request OTP
app.post("/citizen/request-otp", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const cleanEmail = email.trim().toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (existing)
      return res.status(400).json({ message: "Email exists" });

    const hashed = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    

    await prisma.user.create({
      data: {
        name,
        email: cleanEmail,
        password: hashed,
        role: "CITIZEN",
        emailOtp: otp,
        emailOtpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    res.json({ message: "OTP sent" });
  } catch (error) {
    console.log("Signup error:", error);
    res.status(500).json({ message: "Signup failed" });
  }
});

// Citizen Verify OTP
app.post("/citizen/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp)
      return res.status(400).json({ message: "Email and OTP required" });

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user)
      return res.status(400).json({ message: "User not found" });

    if (user.emailOtp !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    if (!user.emailOtpExpiry || user.emailOtpExpiry < new Date())
      return res.status(400).json({ message: "OTP expired" });

    await prisma.user.update({
      where: { email },
      data: {
        emailVerified: true,
        emailOtp: null,
        emailOtpExpiry: null,
      },
    });

    // Send welcome email
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Welcome",
        text: "Welcome to Civic Management Platform.",
      });
    } catch (mailError) {
      console.log("Welcome email failed:", mailError.message);
    }

    res.json({ message: "Verified successfully" });
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Forgot Password - Send Reset OTP
app.post("/citizen/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
      return res.status(400).json({ message: "User not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log("Generated OTP:", otp);

    await prisma.user.update({
      where: { email },
      data: {
        emailOtp: otp,
        emailOtpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Password Reset OTP",
        text: `Your reset OTP is ${otp}`,
      });
    } catch (mailError) {
      console.log("Reset email failed:", mailError.message);
    }

    res.json({ message: "Reset OTP sent" });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Reset Password
app.post("/citizen/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.emailOtp !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    if (!user.emailOtpExpiry || user.emailOtpExpiry < new Date())
      return res.status(400).json({ message: "OTP expired" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { email },
      data: {
        password: hashed,
        emailOtp: null,
        emailOtpExpiry: null,
      },
    });

    res.json({ message: "Password updated" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Change Password
app.post("/citizen/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match)
      return res.status(400).json({ message: "Wrong password" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    res.json({ message: "Password changed" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ================= REPORT ROUTES =================

// Create Report
app.post("/reports", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (user.isBlocked)
      return res.status(403).json({ message: "You are blocked" });

    const { latitude, longitude, address, isCamera } = req.body;

    let district = null;
    if (latitude && longitude)
      district = await getDistrictFromCoords(latitude, longitude);

    let finalImage = req.file ? req.file.filename : null;

    if (isCamera === "true" && req.file) {
      const watermarkText = `${district || "Unknown"} | ${new Date().toLocaleString()}`;

      await sharp(`src/uploads/${req.file.filename}`)
        .composite([
          {
            input: Buffer.from(`
              <svg width="800" height="100">
                <text x="10" y="50" font-size="24" fill="white">
                  ${watermarkText}
                </text>
              </svg>
            `),
            gravity: "southwest",
          },
        ])
        .toFile(`src/uploads/wm-${req.file.filename}`);

      finalImage = `wm-${req.file.filename}`;
    }
// 🔎 DUPLICATE CHECK
const existingReport = await prisma.report.findFirst({
  where: {
    district,
    status: { not: "RESOLVED" },
  }
});

if (existingReport) {

  // Auto vote instead of new report
  await prisma.vote.create({
    data: {
      type: "UP",
      userId: req.user.userId,
      reportId: existingReport.id
    }
  });

  return res.json({
    message: "Similar issue already exists. Vote added.",
    reportId: existingReport.id
  });
}
    const report = await prisma.report.create({
      data: {
        title: "Public Issue",
        description: "Citizen reported civic issue.",
        image: finalImage,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address,
        district,
        userId: req.user.userId,
      },
    });

    res.json(report);
  } catch (error) {
    console.error("Create report error:", error);
    res.status(500).json({ message: "Failed to create report" });
  }
});

// Get All Public Reports
app.get("/public/reports", async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        image: true,
        latitude: true,
        longitude: true,
        address: true,
        district: true,
        status: true,
        createdAt: true,
      },
    });

    res.json(reports);
  } catch (error) {
    console.error("Public reports error:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});

// Get My Reports
app.get("/my-reports", authMiddleware, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: "desc" },
    });

    res.json(reports);
  } catch (error) {
    console.error("My reports error:", error);
    res.status(500).json({ message: "Failed to fetch reports" });
  }
});

// Vote on Report
app.post("/reports/:id/vote", authMiddleware, async (req, res) => {
  try {
    const { type } = req.body;
    const reportId = req.params.id;
    const userId = req.user.userId;

    if (!["UP", "DOWN"].includes(type)) {
      return res.status(400).json({ message: "Invalid vote type" });
    }

    const existingVote = await prisma.vote.findUnique({
      where: {
        userId_reportId: { userId, reportId },
      },
    });

    if (existingVote) {
      return res.status(400).json({ message: "Already voted" });
    }

    await prisma.vote.create({
      data: { type, userId, reportId },
    });

    const upVotes = await prisma.vote.count({
      where: { reportId, type: "UP" },
    });

    const downVotes = await prisma.vote.count({
      where: { reportId, type: "DOWN" },
    });

    const report = await prisma.report.findUnique({
      where: { id: reportId },
    });

    if (upVotes >= 25 && !report.escalated) {
      await prisma.report.update({
        where: { id: reportId },
        data: { escalated: true },
      });

      await prisma.user.update({
        where: { id: report.userId },
        data: { trustScore: { increment: 10 } },
      });
    }

    if (downVotes >= 5) {
      await prisma.user.update({
        where: { id: report.userId },
        data: { trustScore: { decrement: 10 } },
      });
    }

    const updatedUser = await prisma.user.findUnique({
      where: { id: report.userId },
    });

    let newBadge = "Stone";
    if (updatedUser.trustScore >= 50) newBadge = "Diamond";
    else if (updatedUser.trustScore >= 30) newBadge = "Gold";
    else if (updatedUser.trustScore >= 15) newBadge = "Silver";

    await prisma.user.update({
      where: { id: report.userId },
      data: { badge: newBadge },
    });

    res.json({ message: "Vote recorded", upVotes, downVotes });
  } catch (error) {
    console.error("Vote error:", error);
    res.status(500).json({ message: "Error voting" });
  }
});

// Admin Update Report Status (Consolidated)
app.put("/admin/reports/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const reportId = req.params.id;

    const report = await prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report)
      return res.status(404).json({ message: "Report not found" });

    if (report.district !== req.user.district)
      return res.status(403).json({ message: "Not your district" });

    // Update report status
    await prisma.report.update({
      where: { id: reportId },
      data: { status },
    });

    // Fetch citizen
    const citizen = await prisma.user.findUnique({
      where: { id: report.userId },
    });

    // 🔥 EMAIL NOTIFICATION
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: citizen.email,
        subject: "Report Status Updated",
        text: `Hello ${citizen.name},\n\nYour report status is now: ${status}.\n\nThank you for using Civic Management Platform.`,
      });
    } catch (mailError) {
      console.log("Email sending failed:", mailError.message);
    }

    // Trust score logic
    if (status === "RESOLVED") {
      await prisma.user.update({
        where: { id: citizen.id },
        data: {
          validReports: { increment: 1 },
          trustScore: { increment: 5 },
        },
      });

      await prisma.user.update({
        where: { id: req.user.userId },
        data: {
          adminScore: { increment: 5 },
        },
      });
    }

    if (status === "REJECTED") {
      await prisma.user.update({
        where: { id: citizen.id },
        data: {
          rejectedReports: { increment: 1 },
          trustScore: { decrement: 3 },
        },
      });
    }

    res.json({ message: "Report updated successfully" });

  } catch (error) {
    console.error("Admin update error:", error);
    res.status(500).json({ message: "Update failed" });
  }
});

// ================= DASHBOARD & STATS =================
app.get("/citizen/dashboard", authMiddleware, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: { userId: req.user.userId },
    });

    const total = reports.length;
    const pending = reports.filter(r => r.status === "PENDING").length;
    const solved = reports.filter(r => r.status === "RESOLVED").length;

    res.json({ total, pending, solved });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
});

// ================= LEADERBOARD =================
app.get("/leaderboard", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: "CITIZEN" },
      orderBy: { trustScore: "desc" },
      select: {
        id: true,
        name: true,
        trustScore: true,
        badge: true,
        validReports: true,
      },
      take: 10,
    });

    res.json(users);
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ message: "Error fetching leaderboard" });
  }
});

// ================= EXPORT CSV =================
app.get("/export/reports", async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      include: {
        user: true,
      },
    });

    const formattedData = reports.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      district: r.district,
      status: r.status,
      escalated: r.escalated,
      createdAt: r.createdAt,
      userName: r.user.name,
      trustScore: r.user.trustScore,
      badge: r.user.badge,
    }));

    const parser = new Parser();
    const csv = parser.parse(formattedData);

    res.header("Content-Type", "text/csv");
    res.attachment("reports.csv");
    res.send(csv);
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ message: "Error exporting CSV" });
  }
});

// ================= CRON JOB - ESCALATION =================
cron.schedule("0 * * * *", async () => {
  const limitTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const reports = await prisma.report.findMany({
    where: {
      status: { in: ["PENDING", "IN_PROGRESS"] },
      escalated: false,
    },
    include: { _count: { select: { votes: true } } },
  });

  for (let r of reports) {
    const isOld = r.createdAt < limitTime;
    const highVotes = r._count.votes >= 10;

    if (isOld || highVotes) {
      await prisma.report.update({
        where: { id: r.id },
        data: { escalated: true },
      });
    }
  }
});
// ================= ADMIN & AUTHORITY MANAGEMENT =================

// 1️⃣ ADMIN - GET DISTRICT REPORTS
app.get("/admin/reports", authMiddleware, adminOnly, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: {
        district: req.user.district
      },
      include: {
        _count: { select: { votes: true } }
      },
      orderBy: [
        { escalated: "desc" },
        { createdAt: "desc" }
      ]
    });

    res.json(reports);

  } catch (error) {
    res.status(500).json({ message: "Failed to fetch admin reports" });
  }
});


// 2️⃣ AUTHORITY - GET ESCALATED REPORTS
app.get("/authority/escalated-reports", authMiddleware, authorityOnly, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: {
        escalated: true,
        district: req.user.district,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(reports);
  } catch (error) {
    console.error("Escalated fetch error:", error);
    res.status(500).json({ message: "Failed to fetch escalated reports" });
  }
});


// 3️⃣ AUTHORITY - REVIEW REPORT
app.put("/authority/review/:id", authMiddleware, authorityOnly, async (req, res) => {
  try {
    const { status } = req.body;

    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
    });

    if (!report)
      return res.status(404).json({ message: "Report not found" });

    if (report.district !== req.user.district)
      return res.status(403).json({ message: "Not your district" });

    await prisma.report.update({
      where: { id: req.params.id },
      data: {
        status,
        escalated: false,
      },
    });

    res.json({ message: "Authority reviewed successfully" });
  } catch (error) {
    console.error("Authority review error:", error);
    res.status(500).json({ message: "Review failed" });
  }
});


// 4️⃣ ADMIN - DASHBOARD STATS
app.get("/admin/dashboard", authMiddleware, adminOnly, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: {
        district: req.user.district,
      },
    });

    const total = reports.length;
    const pending = reports.filter(r => r.status === "PENDING").length;
    const solved = reports.filter(r => r.status === "RESOLVED").length;

    res.json({ total, pending, solved });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({ message: "Dashboard failed" });
  }
});

// ================= AUTHORITY DASHBOARD =================
app.get("/authority/dashboard", authMiddleware, authorityOnly, async (req, res) => {
  try {
    const reports = await prisma.report.findMany({
      where: { district: req.user.district }
    });

    const total = reports.length;
    const pending = reports.filter(r => r.status === "PENDING").length;
    const inProgress = reports.filter(r => r.status === "IN_PROGRESS").length;
    const resolved = reports.filter(r => r.status === "RESOLVED").length;
    const escalated = reports.filter(r => r.escalated === true).length;

    res.json({
      total,
      pending,
      inProgress,
      resolved,
      escalated
    });

  } catch (error) {
    res.status(500).json({ message: "Authority dashboard failed" });
  }
});
// ================= UPDATE NAME =================
app.put("/citizen/update-name", authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name)
      return res.status(400).json({ message: "Name required" });

    await prisma.user.update({
      where: { id: req.user.userId },
      data: { name },
    });

    res.json({ message: "Name updated successfully" });

  } catch (error) {
    res.status(500).json({ message: "Failed to update name" });
  }
});
// ================= UPDATE PROFILE PHOTO =================
app.put("/citizen/update-photo", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ message: "Image required" });

    await prisma.user.update({
      where: { id: req.user.userId },
      data: { profilePhoto: req.file.filename },
    });

    res.json({ message: "Profile photo updated" });

  } catch (error) {
    res.status(500).json({ message: "Failed to update photo" });
  }
});
// ================= UPDATE EMAIL REQUEST OTP =================
app.post("/citizen/update-email-request", authMiddleware, async (req, res) => {
  try {
    const { newEmail } = req.body;

    if (!newEmail)
      return res.status(400).json({ message: "Email required" });

    const cleanEmail = newEmail.trim().toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail }
    });

    if (existing)
      return res.status(400).json({ message: "Email already in use" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        emailOtp: otp,
        emailOtpExpiry: new Date(Date.now() + 5 * 60 * 1000),
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: cleanEmail,
      subject: "Email Update OTP",
      text: `Your OTP is ${otp}`
    });

    res.json({ message: "OTP sent to new email" });

  } catch (error) {
    res.status(500).json({ message: "Failed to send OTP" });
  }
});
// ================= VERIFY & UPDATE EMAIL =================
app.post("/citizen/update-email-verify", authMiddleware, async (req, res) => {
  try {
    const { newEmail, otp } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }
    });

    if (user.emailOtp !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    if (!user.emailOtpExpiry || user.emailOtpExpiry < new Date())
      return res.status(400).json({ message: "OTP expired" });

    await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        email: newEmail.trim().toLowerCase(),
        emailOtp: null,
        emailOtpExpiry: null,
      }
    });

    res.json({ message: "Email updated successfully" });

  } catch (error) {
    res.status(500).json({ message: "Email update failed" });
  }
});
// ================= START SERVER =================

app.get("/health", (req, res) => {
  res.status(200).json({ message: "Backend working 🚀" });
});
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
