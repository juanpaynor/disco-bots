// Delete an audit and everything hanging off it (prompts, jobs, results cascade).
import { prisma } from "./db.js";
const auditId = process.argv[2];
if (!auditId) { console.error("usage: npm run cleanup -- <auditId>"); process.exit(1); }
const audit = await prisma.audit.delete({ where: { id: auditId } });
console.log(`deleted audit "${audit.name}" (${audit.id})`);
await prisma.$disconnect();
