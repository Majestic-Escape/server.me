const User = require("../models/User");
const jwt = require("jsonwebtoken");
const authController = {
  verifyToken: (req, res) => {
    try {
      // The authMiddleware has already verified the token
      // and attached the user to the request object
      res.status(200).json({
        success: true,
        code: "AUTH_TOKEN_VALID",
        message: "Token is valid",
        user: req.user,
        statusCode: 200,
        requestType: "VERIFY_AUTH",
      });
    } catch (error) {
      console.error("Verify Token Error:", error);
      res.status(500).json({
        requestType: "VERIFY_AUTH",
        success: false,
        code: "AUTH_VERIFICATION_ERROR",
        message: "An error occurred while verifying the token",
        statusCode: 500,
      });
    }
  },
  checkToken: async (req, res) => {
    try {
      const token = req.body.token;

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log("Enter banning 0");
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

      if (user.status?.banned === true) {
        return res.status(403).json({
          success: false,
          code: "USER_BANNED",
          message: "Your account has been banned",
          statusCode: 403,
          requestType: req.method,
        });
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
      // If everything is fine
      return res.status(200).json({
        success: true,
        message: "Token is valid",
        decoded,
      });
    } catch (error) {
      console.error(error);

      // if (error.name === "TokenExpiredError") {
      //   return res.status(401).json({
      //     success: false,
      //     message: "Token expired",
      //   });
      // }

      // return res.status(400).json({
      //   success: false,
      //   message: "Invalid token",
      // });
    }
  },
};

module.exports = authController;
