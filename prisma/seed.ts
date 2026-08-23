import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ROLES = [
  {
    code: 'ADMIN',
    name: 'Platform Admin',
    description: 'Super-admin across all companies',
  },
  {
    code: 'OWNER',
    name: 'Company Owner',
    description: 'Owns and administers a company',
  },
  {
    code: 'MANAGER',
    name: 'Store Manager',
    description: 'Manages a company_store and its members',
  },
  { code: 'STAFF', name: 'Staff', description: 'Company staff member' },
];

const PERMISSIONS = [
  { code: 'users.create', name: 'Create users' },
  { code: 'users.read', name: 'Read users' },
  { code: 'users.update', name: 'Update users' },
  { code: 'users.delete', name: 'Delete users' },
  { code: 'users.approve', name: 'Approve users' },
  { code: 'companies.read', name: 'Read companies' },
  { code: 'companies.update', name: 'Update companies' },
  { code: 'companies.approve', name: 'Approve companies' },
  { code: 'categories.create', name: 'Create categories' },
  { code: 'categories.read', name: 'Read categories' },
  { code: 'categories.update', name: 'Update categories' },
  { code: 'categories.delete', name: 'Delete categories' },
  { code: 'brands.create', name: 'Create brands' },
  { code: 'brands.read', name: 'Read brands' },
  { code: 'brands.update', name: 'Update brands' },
  { code: 'brands.delete', name: 'Delete brands' },
  { code: 'products.create', name: 'Create products' },
  { code: 'products.read', name: 'Read products' },
  { code: 'products.update', name: 'Update products' },
  { code: 'products.delete', name: 'Delete products' },
  { code: 'stores.create', name: 'Create stores' },
  { code: 'stores.read', name: 'Read stores' },
  { code: 'stores.update', name: 'Update stores' },
  { code: 'stores.delete', name: 'Delete stores' },
  { code: 'corners.create', name: 'Create corners' },
  { code: 'corners.read', name: 'Read corners' },
  { code: 'corners.update', name: 'Update corners' },
  { code: 'corners.delete', name: 'Delete corners' },
  { code: 'corners.assign', name: 'Assign corner manager and staff' },
  { code: 'placements.create', name: 'Create placements' },
  { code: 'placements.read', name: 'Read placements' },
  { code: 'placements.update', name: 'Update placements' },
  { code: 'placements.delete', name: 'Delete placements' },
  { code: 'transactions.create', name: 'Create inventory transactions' },
  { code: 'transactions.read', name: 'Read inventory transactions' },
  { code: 'orders.create', name: 'Create orders' },
  { code: 'orders.read', name: 'Read orders' },
  { code: 'orders.update', name: 'Update orders' },
  { code: 'orders.delete', name: 'Delete orders' },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: PERMISSIONS.map((permission) => permission.code),
  OWNER: [
    'users.create',
    'users.read',
    'users.update',
    'users.delete',
    'users.approve',
    'companies.read',
    'companies.update',
    'products.create',
    'products.read',
    'products.update',
    'products.delete',
    'brands.create',
    'brands.read',
    'brands.update',
    'brands.delete',
    'categories.read',
    'stores.read',
    'corners.create',
    'corners.read',
    'corners.update',
    'corners.delete',
    'corners.assign',
    'placements.create',
    'placements.read',
    'placements.update',
    'placements.delete',
    'transactions.create',
    'transactions.read',
    'orders.create',
    'orders.read',
    'orders.update',
    'orders.delete',
  ],
  MANAGER: [
    'users.create',
    'users.read',
    'users.update',
    'users.delete',
    'users.approve',
    'companies.read',
    'products.create',
    'products.read',
    'products.update',
    'products.delete',
    'brands.create',
    'brands.read',
    'brands.update', // note: NO brands.delete
    'categories.read',
    'stores.read',
    'corners.read',
    'corners.assign',
    'placements.create',
    'placements.read',
    'placements.update',
    'placements.delete',
    'transactions.create',
    'transactions.read',
    'orders.create',
    'orders.read',
    'orders.update',
    'orders.delete',
  ],
  STAFF: [
    'users.read',
    'users.update',
    'users.delete',
    'companies.read',
    'products.read',
    'brands.read',
    'categories.read',
    'stores.read',
    'corners.read',
    'placements.create',
    'placements.read',
    'placements.update',
    'placements.delete',
    'transactions.create',
    'transactions.read',
    'orders.create',
    'orders.read',
    'orders.update',
    'orders.delete',
  ],
};

async function main() {
  // 1) Roles — idempotent by unique `code`
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, description: role.description },
      create: role,
    });
  }

  // 2) Permissions — resource/action derived from the code (e.g. "users.create")
  for (const perm of PERMISSIONS) {
    const [resource, action] = perm.code.split('.');
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: { name: perm.name, resource, action },
      create: { code: perm.code, name: perm.name, resource, action },
    });
  }

  // 3) Role → permission baselines
  for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: roleCode },
    });
    for (const code of permCodes) {
      const perm = await prisma.permission.findUniqueOrThrow({
        where: { code },
      });
      await prisma.rolePermission.upsert({
        where: {
          permissionId_roleId: { permissionId: perm.id, roleId: role.id },
        },
        update: {},
        create: { permissionId: perm.id, roleId: role.id },
      });
    }
  }

  // 4) Platform admin (company_id = null — the nullable column from Task 1)
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
  }

  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'ADMIN' },
  });
  const existing = await prisma.userLoginMethod.findFirst({
    where: { email, method: 'local' },
  });

  if (existing) {
    console.log(`Platform admin already exists (${email}) — skipping.`);
  } else {
    const passwordHash = await argon2.hash(password);
    await prisma.user.create({
      data: {
        roleId: adminRole.id,
        name: 'Platform Admin',
        status: 'ACTIVE',
        loginMethods: {
          create: { method: 'local', email, passwordHash, emailVerified: true },
        },
      },
    });
    console.log(`Platform admin created: ${email}`);
  }
}

main()
  .then(() => console.log('✅ Seed complete'))
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
