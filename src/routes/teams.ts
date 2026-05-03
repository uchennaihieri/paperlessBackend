import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any, requireAdmin as any);

// ── GET /api/v1/teams ─────────────────────────────────────────────────────────
// All active, unlocked users grouped by email
router.get("/", async (_req, res: Response) => {
  const users = await prisma.user.findMany({
    where: {
      status: { equals: "active", mode: "insensitive" },
      OR: [{ lock_flag: false }, { lock_flag: null }],
    },
    orderBy: { user_name: "asc" },
  });

  const grouped = users.reduce(
    (acc: any, user: any) => {
      const key = user.finca_email || user.employee_id || user.id.toString();
      if (!acc[key]) {
        acc[key] = {
          key,
          email: user.finca_email,
          employee_id: user.employee_id,
          user_name: user.user_name,
          login_id: user.login_id,
          user_no: user.user_no,
          roles: [] as typeof users,
        };
      }
      acc[key].roles.push(user); // each role row includes user_role, branch, specialAccess
      return acc;
    },
    {} as Record<string, any>
  );

  res.json({ success: true, data: Object.values(grouped) });
});

// ── POST /api/v1/teams ────────────────────────────────────────────────────────
// Create a new user record
router.post("/", async (req: AuthRequest, res: Response) => {
  const { user_name, finca_email, employee_id, login_id, user_no, user_role, branch, specialAccess } = req.body;

  const maxUser = await prisma.user.aggregate({ _max: { id: true } });
  const nextId = (maxUser._max.id || 0) + 1;

  await prisma.user.create({
    data: {
      id: nextId,
      user_name,
      finca_email,
      employee_id,
      login_id,
      user_no,
      user_role,
      branch,
      specialAccess: specialAccess && specialAccess !== "None" ? specialAccess : null,
      status: "active",
      lock_flag: false,
      creation_date: new Date(),
    },
  });
  res.status(201).json({ success: true });
});

// ── PATCH /api/v1/teams/:id/status ───────────────────────────────────────────
router.patch("/:id/status", async (req, res: Response) => {
  const id = parseInt(req.params.id);
  const { status, lock_flag } = req.body;
  await prisma.user.update({ where: { id }, data: { status, lock_flag } });
  res.json({ success: true });
});

// ── PATCH /api/v1/teams/bulk-info ────────────────────────────────────────────
// Update shared info for a group of user IDs (same person, multiple roles)
router.patch("/bulk-info", async (req, res: Response) => {
  const { ids, data } = req.body as {
    ids: number[];
    data: { user_name: string; finca_email: string; employee_id: string; login_id: string; user_no: string };
  };
  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: {
      user_name: data.user_name,
      finca_email: data.finca_email,
      employee_id: data.employee_id,
      login_id: data.login_id,
      user_no: data.user_no,
    },
  });
  res.json({ success: true });
});

// ── PATCH /api/v1/teams/:id ───────────────────────────────────────────────────
// Update per-row fields: user_role, branch, specialAccess
router.patch("/:id", async (req, res: Response) => {
  const id = parseInt(req.params.id);
  const { user_role, branch, specialAccess } = req.body;
  await prisma.user.update({
    where: { id },
    data: {
      ...(user_role !== undefined ? { user_role } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(specialAccess !== undefined ? { specialAccess: specialAccess === "None" ? null : specialAccess } : {}),
    },
  });
  res.json({ success: true });
});

// ── DELETE /api/v1/teams/:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res: Response) => {
  const id = parseInt(req.params.id);
  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
});

// ── GET /api/v1/teams/user-by-employee-id/:empId ────────────────────────────
// Resolve a user's DB id from their employee_id (used after creation to set password)
router.get("/user-by-employee-id/:empId", async (req, res: Response) => {
  const user = await prisma.user.findFirst({
    where: { employee_id: { equals: req.params.empId, mode: "insensitive" } },
    select: { id: true, user_name: true, finca_email: true, employee_id: true },
    orderBy: { id: "desc" }, // take most recently created if duplicates
  });
  if (!user) {
    res.status(404).json({ success: false, error: "User not found." });
    return;
  }
  res.json({ success: true, data: user });
});

export default router;
