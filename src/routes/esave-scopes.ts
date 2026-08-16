import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Get eSave scopes for a specific phone number
router.get('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const scopeRecord = await prisma.eSaveAdminScope.findUnique({
      where: { phone },
    });

    if (!scopeRecord) {
      return res.json({ phone, scopes: [] });
    }

    res.json({
      phone: scopeRecord.phone,
      scopes: scopeRecord.scopes,
    });
  } catch (error) {
    console.error('Error fetching eSave scopes:', error);
    res.status(500).json({ error: 'Failed to fetch eSave scopes' });
  }
});

// Create or update eSave scopes for a phone number
router.put('/', async (req, res) => {
  try {
    const { phone, scopes } = req.body;

    if (!phone || !Array.isArray(scopes)) {
      return res.status(400).json({ error: 'Phone and an array of scopes are required' });
    }

    const scopeRecord = await prisma.eSaveAdminScope.upsert({
      where: { phone },
      update: { scopes },
      create: { phone, scopes },
    });

    res.json({
      message: 'Scopes updated successfully',
      scopes: scopeRecord.scopes,
    });
  } catch (error) {
    console.error('Error updating eSave scopes:', error);
    res.status(500).json({ error: 'Failed to update eSave scopes' });
  }
});

export default router;
