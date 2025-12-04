const jwt = require("jsonwebtoken");
const User = require("../models/User");

const authMiddleware = async (req, res, next) => {
  try {
    console.log("Enter authmiddleware");
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

    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });
    console.log("Enter banning 0");
    if (decoded.admin == 0) {
      console.log("Enter banning", decoded.admin);
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          code: "USER_NOT_FOUND",
          message: "User does not exist",
          statusCode: 404,
          requestType: req.method,
        });
      }
      console.log("Enter banning2");
      // 🚫 BLOCK BANNED USERS IMMEDIATELY
      if (user.status?.banned === true) {
        return res.status(403).json({
          success: false,
          code: "USER_BANNED",
          message: "Your account has been banned",
          statusCode: 403,
          requestType: req.method,
        });
      }
      console.log("Enter banning3");
      // 🚫 FORCE LOGOUT IF tokenVersion DOESN’T MATCH
      if (decoded.tokenVersion !== user.tokenVersion) {
        return res.status(401).json({
          success: false,
          code: "TOKEN_INVALIDATED",
          message: "Session expired. Please log in again",
          statusCode: 401,
          requestType: req.method,
        });
      }
      console.log("Enter banning4");
      req.user = user;
      next();
    } else {
      req.user = decoded;
      next();
    }
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
