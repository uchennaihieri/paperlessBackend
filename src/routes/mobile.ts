import { Router } from "express";
import mobileSendOtpRouter from "./mobile/sendOtp";
import mobileVerifyOtpRouter from "./mobile/verifyOtp";
import mobileDashboardRouter from "./mobile/dashboard";
import mobileDepositRouter from "./mobile/deposit";
import mobilePartialRouter from "./mobile/partial";

const router = Router();

router.use("/auth/send-otp", mobileSendOtpRouter);
router.use("/auth/verify-otp", mobileVerifyOtpRouter);
router.use("/dashboard", mobileDashboardRouter);
router.use("/submissions/deposit", mobileDepositRouter);
router.use("/submissions/partial", mobilePartialRouter);

export default router;
