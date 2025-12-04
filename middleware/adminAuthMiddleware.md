const jwt = require("jsonwebtoken");
const User = require("../models/User");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];

    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        code: "AUTH_TOKEN_MISSING",
        message: "No token provided",
        statusCode: 401,
        requestType: req.method,
      });
    }

    const user = await new Promise((resolve, reject) => {
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        code: "AUTH_TOKEN_EXPIRED",
        message: "Token expired",
        statusCode: 401,
        requestType: req.method,
      });
    }

    return res.status(403).json({
      success: false,
      code: "AUTH_TOKEN_INVALID",
      message: "Invalid token",
      statusCode: 403,
      requestType: req.method,
    });
  }
};

module.exports = authMiddleware;
