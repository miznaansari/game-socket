const { PrismaClient } = require("@prisma/client");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const fs = require("fs");
const path = require("path");

let prisma;
try {
  let dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    const envPath = path.join(__dirname, "..", ".env");
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, "utf8");
      const envVars = {};
      envFile.split("\n").forEach(line => {
        const parts = line.split("=");
        if (parts.length >= 2) {
          envVars[parts[0].trim()] = parts.slice(1).join("=").trim().replace(/^"(.*)"$/, "$1");
        }
      });
      dbUrl = envVars.DATABASE_URL;
    }
  }

  const parsedUrl = new URL(dbUrl);
  const adapter = new PrismaMariaDb({
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port || "3306", 10),
    user: parsedUrl.username,
    password: decodeURIComponent(parsedUrl.password),
    database: parsedUrl.pathname.replace(/^\//, ""),
  });

  prisma = new PrismaClient({ adapter });
} catch (err) {
  console.error("Prisma init failed in script:", err);
  prisma = new PrismaClient();
}

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true }
  });
  console.log("USERS:", JSON.stringify(users, null, 2));
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
