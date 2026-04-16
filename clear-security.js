const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe('DELETE FROM "SecurityData"');
  console.log('SecurityData cleared');
  await prisma.$disconnect();
}
main().catch(console.error);
