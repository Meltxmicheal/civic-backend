module.exports = (req, res, next) => {
  if (req.user.role !== "AUTHORITY") {
    return res.status(403).json({ message: "Access denied. Authority only." });
  }
  next();
};