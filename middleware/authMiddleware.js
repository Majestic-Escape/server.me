const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authz = require("./authz");

const authMiddleware = async (req, res, next) => {
  try {
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Enter authmiddleware");
    }
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
    if (process.env.NEXT_PUBLIC_ENV === "dev") {
      console.log("Enter banning 0");
    }
    if (decoded.admin == 0) {
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Enter banning", decoded.admin);
      }
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
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Enter banning2");
      }
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
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Enter banning3");
      }
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
      if (process.env.NEXT_PUBLIC_ENV === "dev") {
        console.log("Enter banning4");
      }
      req.user = user;
      // The response PII filter keys on req.actor; for a user token it is
      // the loaded document (no extra query).
      await authz.resolveActor(req);
      next();
    } else {
      req.user = decoded;
      // Admin-shaped tokens (no `admin` claim: admin login, registration)
      // resolve to a DB-verified Admin or User record; a token that is
      // neither has no business here. One Admin.findById per admin request.
      const actor = await authz.resolveActor(req);
      if (!actor) {
        return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Authentication required", statusCode: 401 });
      }
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
