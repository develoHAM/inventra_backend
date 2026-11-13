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
  { code: 'profiles.create', name: 'Create profiles' },
  { code: 'profiles.read', name: 'Read profiles' },
  { code: 'profiles.update', name: 'Update profiles' },
  { code: 'profiles.delete', name: 'Delete profiles' },
  { code: 'profiles.approve', name: 'Approve profiles' },
  { code: 'profiles.move', name: 'Move members between branches' },
  { code: 'profiles.changeRole', name: 'Change member roles' },
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
  { code: 'audits.create', name: 'Create audits' },
  { code: 'audits.read', name: 'Read audits' },
  { code: 'audits.update', name: 'Update audits' },
  { code: 'audits.delete', name: 'Delete audits' },
  { code: 'audits.apply', name: 'Apply audits' },
  { code: 'reservations.create', name: 'Create reservations' },
  { code: 'reservations.read', name: 'Read reservations' },
  { code: 'reservations.fulfill', name: 'Fulfill reservations' },
  { code: 'reservations.cancel', name: 'Cancel reservations' },
  { code: 'companies.invite', name: 'View the company join code' },
  { code: 'companies.rotateJoinCode', name: 'Rotate the company join code' },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: PERMISSIONS.map((permission) => permission.code),
  OWNER: [
    'profiles.create',
    'profiles.read',
    'profiles.update',
    'profiles.delete',
    'profiles.approve',
    'profiles.move',
    'profiles.changeRole',
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
    'audits.create',
    'audits.read',
    'audits.update',
    'audits.delete',
    'audits.apply',
    'reservations.create',
    'reservations.read',
    'reservations.fulfill',
    'reservations.cancel',
    'companies.invite',
    'companies.rotateJoinCode',
  ],
  MANAGER: [
    'profiles.create',
    'profiles.read',
    'profiles.update',
    'profiles.delete',
    'profiles.approve', // own branch, as staff only (ProfilesService)
    'profiles.changeRole', // staff → manager in their own branch only
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
    'audits.create',
    'audits.read',
    'audits.update',
    'audits.delete',
    'audits.apply',
    'reservations.create',
    'reservations.read',
    'reservations.fulfill',
    'reservations.cancel',
    'companies.invite',
  ],
  STAFF: [
    'profiles.read',
    'profiles.update',
    'profiles.delete',
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
    'audits.create',
    'audits.read',
    'audits.update',
    'audits.delete',
    'audits.apply',
    'reservations.create',
    'reservations.read',
    'reservations.fulfill',
    'reservations.cancel',
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

  // 2) Permissions — resource/action derived from the code (e.g. "profiles.create")
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
  // stored lowercase like every email (login compares the lowercased input)
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
  }

  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'ADMIN' },
  });
  const existing = await prisma.accountLoginMethod.findFirst({
    where: { email, method: 'local' },
  });

  if (existing) {
    console.log(`Platform admin already exists (${email}) — skipping.`);
  } else {
    const passwordHash = await argon2.hash(password);
    // The sign-in (no phone: the admin is not a phone signup) with its
    // password login, and its company-less ADMIN profile.
    await prisma.account.create({
      data: {
        phone: null,
        loginMethods: {
          create: {
            method: 'local',
            email: email,
            passwordHash: passwordHash,
            emailVerified: true,
          },
        },
        profiles: {
          create: {
            roleId: adminRole.id,
            name: 'Platform Admin',
            status: 'ACTIVE',
            // where notifications go (findProfileEmail reads contactEmail, not the login)
            contactEmail: email,
          },
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
