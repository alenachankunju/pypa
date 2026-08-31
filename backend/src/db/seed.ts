/**
 * Database seeding.
 *
 *   npm run db:seed        Create the initial Super Admin only (FSD 3.1).
 *   npm run db:seed:demo   Also create a populated demo event.
 *
 * The demo event is not decoration. FSD 14.3 lists "Judge unfamiliar with the
 * application" as a high-impact risk whose mitigation is a "mandatory rehearsal
 * session with dummy data before the event", and FSD 16 states that "a marking
 * system that has not been rehearsed under realistic conditions has not been
 * tested". This is that dummy data.
 *
 * The demo also reproduces the FSD 7.5 worked example exactly, so an end-to-end
 * run can be checked against the specification by eye.
 */
import { env } from '../config/env.js';
import { generateTemporaryPassword, hashPassword } from '../services/auth/password.js';
import { closePool, db } from './pool.js';

const DEMO = process.argv.includes('--demo');

async function main(): Promise<void> {
  console.log('\nPYPA Marking System — seeding\n');

  const superAdminId = await seedSuperAdmin();
  if (DEMO) await seedDemoEvent(superAdminId);

  console.log('\nSeeding complete.\n');
}

/**
 * FSD 3.1: the Super Admin role is "seeded at install", then managed by Super
 * Admins thereafter. This is the only account the system creates for itself —
 * AC-02 forbids any self-registration route.
 */
async function seedSuperAdmin(): Promise<string> {
  const existing = await db
    .selectFrom('users')
    .select(['id', 'username'])
    .where('role', '=', 'SUPER_ADMIN')
    .executeTakeFirst();

  if (existing) {
    console.log(`  Super Admin already exists (${existing.username}) — left unchanged.`);
    return existing.id;
  }

  const password = env.SEED_SUPERADMIN_PASSWORD || generateTemporaryPassword(12);

  const user = await db
    .insertInto('users')
    .values({
      username: env.SEED_SUPERADMIN_USERNAME,
      full_name: env.SEED_SUPERADMIN_NAME,
      password_hash: await hashPassword(password),
      role: 'SUPER_ADMIN',
      // ADM-01-05: even the seeded account must change its password at first use.
      must_change_password: true,
      can_revoke_scores: true,
    })
    .returning(['id', 'username'])
    .executeTakeFirstOrThrow();

  console.log('  Super Admin created.');
  console.log(`    username: ${user.username}`);
  console.log(`    password: ${password}`);
  console.log('    This password must be changed at first sign-in and is not stored anywhere.\n');

  return user.id;
}

async function seedDemoEvent(actorId: string): Promise<void> {
  const existing = await db
    .selectFrom('events')
    .select('id')
    .where('name', '=', 'PYPA Demo Event')
    .executeTakeFirst();

  if (existing) {
    console.log('  Demo event already exists — left unchanged.');
    return;
  }

  console.log('  Creating demo event...');

  await db.transaction().execute(async (trx) => {
    const by = { created_by: actorId, updated_by: actorId };

    // --- Event, with the FSD 18.2 defaults ---------------------------------
    await trx
      .updateTable('events')
      .set({ status: 'SETUP' })
      .where('status', '=', 'ACTIVE')
      .execute();

    const event = await trx
      .insertInto('events')
      .values({
        name: 'PYPA Demo Event',
        edition: '2026',
        start_date: '2026-09-12',
        end_date: '2026-09-13',
        // ADM-03-03: age is computed as at this date, not as at today.
        age_cutoff_date: '2026-01-01',
        timezone: 'Asia/Kolkata',
        status: 'ACTIVE',
        ...by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('scoring_config')
      .values({ event_id: event.id, ...by })
      .execute();

    // FSD 18.2: 1st = 5, 2nd = 3, 3rd = 1.
    await trx
      .insertInto('position_points')
      .values(
        [
          [1, 5],
          [2, 3],
          [3, 1],
        ].map(([position, points]) => ({
          event_id: event.id,
          item_id: null,
          position: position!,
          points: points!,
          ...by,
        })),
      )
      .execute();

    // FSD 18.2: A >= 80%, B >= 60%, C >= 40%, grade points disabled.
    await trx
      .insertInto('grade_bands')
      .values(
        [
          ['A', 80],
          ['B', 60],
          ['C', 40],
        ].map(([grade, min], index) => ({
          event_id: event.id,
          grade: grade as string,
          min_percentage: min as number,
          points: 0,
          display_order: index,
          ...by,
        })),
      )
      .execute();

    // --- Categories (FSD glossary examples) --------------------------------
    const categories = await trx
      .insertInto('categories')
      .values(
        [
          { name: 'Sub-Junior', min_age: 6, max_age: 10, display_order: 1 },
          { name: 'Junior', min_age: 11, max_age: 15, display_order: 2 },
          { name: 'Senior', min_age: 16, max_age: 25, display_order: 3 },
          { name: 'Super-Senior', min_age: 26, max_age: 99, display_order: 4 },
        ].map((c) => ({ event_id: event.id, ...c, ...by })),
      )
      .returning(['id', 'name'])
      .execute();

    const categoryByName = new Map(categories.map((c) => [c.name, c.id]));

    // --- Churches (global master data) -------------------------------------
    const churches = await trx
      .insertInto('churches')
      .values(
        [
          { name: 'Zion Church', short_code: 'ZION', zone: 'North' },
          { name: 'Bethel Church', short_code: 'BTH', zone: 'North' },
          { name: 'Calvary Church', short_code: 'CAL', zone: 'South' },
          { name: 'Emmanuel Church', short_code: 'EMM', zone: 'South' },
        ].map((c) => ({ ...c, ...by })),
      )
      .returning(['id', 'name', 'short_code'])
      .execute();

    const churchByCode = new Map(churches.map((c) => [c.short_code, c.id]));

    // --- Items --------------------------------------------------------------
    const items = await trx
      .insertInto('items')
      .values([
        {
          event_id: event.id,
          name: 'Solo Song — Junior Girls',
          code: 'SS-JG',
          category_id: categoryByName.get('Junior')!,
          type: 'INDIVIDUAL' as const,
          gender_restriction: 'FEMALE' as const,
          max_mark: 10,
          stage: 'Main Stage',
          max_per_church: 2,
          display_order: 1,
          ...by,
        },
        {
          event_id: event.id,
          name: 'Bible Quiz — Senior',
          code: 'BQ-SR',
          category_id: categoryByName.get('Senior')!,
          type: 'INDIVIDUAL' as const,
          max_mark: 10,
          stage: 'Hall B',
          max_per_church: 1,
          display_order: 2,
          ...by,
        },
        {
          event_id: event.id,
          name: 'Group Song — Open',
          code: 'GS-OP',
          open_to_all_categories: true,
          type: 'GROUP' as const,
          max_mark: 10,
          stage: 'Main Stage',
          min_team_size: 3,
          max_team_size: 6,
          // Q9: group items default to a 2.0 multiplier.
          weight_multiplier: 2.0,
          max_per_church: 1,
          display_order: 3,
          ...by,
        },
      ])
      .returning(['id', 'code'])
      .execute();

    const itemByCode = new Map(items.map((i) => [i.code, i.id]));

    // --- Members ------------------------------------------------------------
    // The first four reproduce the FSD 7.5 worked example.
    const memberSpecs = [
      { chest: '118', name: 'Sarah John', church: 'ZION', dob: '2012-04-11', gender: 'FEMALE', cat: 'Junior' },
      { chest: '104', name: 'Anna Mathew', church: 'BTH', dob: '2012-08-02', gender: 'FEMALE', cat: 'Junior' },
      { chest: '132', name: 'Rebecca Thomas', church: 'CAL', dob: '2013-01-20', gender: 'FEMALE', cat: 'Junior' },
      { chest: '145', name: 'Grace Varghese', church: 'BTH', dob: '2011-11-30', gender: 'FEMALE', cat: 'Junior' },
      { chest: '201', name: 'Daniel Kurian', church: 'ZION', dob: '2005-03-15', gender: 'MALE', cat: 'Senior' },
      { chest: '202', name: 'Philip Abraham', church: 'BTH', dob: '2004-07-09', gender: 'MALE', cat: 'Senior' },
      { chest: '203', name: 'Mariam Joseph', church: 'CAL', dob: '2006-02-28', gender: 'FEMALE', cat: 'Senior' },
      { chest: '204', name: 'Thomas Alex', church: 'EMM', dob: '2005-12-01', gender: 'MALE', cat: 'Senior' },
      { chest: '301', name: 'Hannah Samuel', church: 'ZION', dob: '2008-05-05', gender: 'FEMALE', cat: 'Senior' },
      { chest: '302', name: 'Jacob Varghese', church: 'ZION', dob: '2009-09-19', gender: 'MALE', cat: 'Senior' },
      { chest: '303', name: 'Elizabeth Paul', church: 'ZION', dob: '2007-06-14', gender: 'FEMALE', cat: 'Senior' },
      { chest: '311', name: 'Ruth Cherian', church: 'BTH', dob: '2008-10-22', gender: 'FEMALE', cat: 'Senior' },
      { chest: '312', name: 'Stephen Mani', church: 'BTH', dob: '2007-03-08', gender: 'MALE', cat: 'Senior' },
      { chest: '313', name: 'Naomi George', church: 'BTH', dob: '2009-01-17', gender: 'FEMALE', cat: 'Senior' },
    ];

    const members = await trx
      .insertInto('members')
      .values(
        memberSpecs.map((m) => ({
          event_id: event.id,
          chest_number: m.chest,
          full_name: m.name,
          date_of_birth: m.dob,
          gender: m.gender as 'MALE' | 'FEMALE',
          church_id: churchByCode.get(m.church)!,
          category_id: categoryByName.get(m.cat)!,
          derived_category_id: categoryByName.get(m.cat)!,
          ...by,
        })),
      )
      .returning(['id', 'chest_number', 'church_id'])
      .execute();

    const memberByChest = new Map(members.map((m) => [m.chest_number, m]));

    // --- Registrations ------------------------------------------------------
    const soloSong = itemByCode.get('SS-JG')!;
    const bibleQuiz = itemByCode.get('BQ-SR')!;
    const groupSong = itemByCode.get('GS-OP')!;

    // Solo Song — the four from the FSD 7.5 example, in that order.
    await trx
      .insertInto('registrations')
      .values(
        ['118', '104', '132', '145'].map((chest, index) => ({
          event_id: event.id,
          item_id: soloSong,
          member_id: memberByChest.get(chest)!.id,
          church_id: memberByChest.get(chest)!.church_id,
          call_order: index + 1,
          ...by,
        })),
      )
      .execute();

    await trx
      .insertInto('registrations')
      .values(
        ['201', '202', '203', '204'].map((chest, index) => ({
          event_id: event.id,
          item_id: bibleQuiz,
          member_id: memberByChest.get(chest)!.id,
          church_id: memberByChest.get(chest)!.church_id,
          call_order: index + 1,
          ...by,
        })),
      )
      .execute();

    // Two teams for the group item.
    for (const [index, team] of [
      { name: 'Zion Voices', church: 'ZION', members: ['301', '302', '303'] },
      { name: 'Bethel Harmony', church: 'BTH', members: ['311', '312', '313'] },
    ].entries()) {
      const registration = await trx
        .insertInto('registrations')
        .values({
          event_id: event.id,
          item_id: groupSong,
          member_id: null,
          team_name: team.name,
          church_id: churchByCode.get(team.church)!,
          call_order: index + 1,
          ...by,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('registration_members')
        .values(
          team.members.map((chest, memberIndex) => ({
            registration_id: registration.id,
            member_id: memberByChest.get(chest)!.id,
            item_id: groupSong,
            is_team_leader: memberIndex === 0,
            ...by,
          })),
        )
        .execute();
    }

    // --- Judges (a panel of three, per FSD 2.5 and Q2) ---------------------
    const judgePassword = 'JudgeDemo1';
    const judgeHash = await hashPassword(judgePassword);

    const judges = await trx
      .insertInto('users')
      .values(
        [
          { username: 'judge1', full_name: 'Judge One — Pr. Mathew Samuel' },
          { username: 'judge2', full_name: 'Judge Two — Mrs. Leela Thomas' },
          { username: 'judge3', full_name: 'Judge Three — Mr. Roy Abraham' },
        ].map((j) => ({
          ...j,
          password_hash: judgeHash,
          role: 'JUDGE' as const,
          // Demo accounts skip the forced change so a rehearsal can start at once.
          must_change_password: false,
          ...by,
        })),
      )
      .returning(['id', 'username'])
      .execute();

    const coordinator = await trx
      .insertInto('users')
      .values({
        username: 'coordinator',
        full_name: 'Stage Coordinator',
        password_hash: judgeHash,
        role: 'COORDINATOR',
        must_change_password: false,
        ...by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // --- Panel and session --------------------------------------------------
    const panel = await trx
      .insertInto('panels')
      .values({
        event_id: event.id,
        name: 'Main Stage Panel',
        chief_judge_id: judges[0]!.id,
        ...by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('panel_judges')
      .values(judges.map((j) => ({ panel_id: panel.id, user_id: j.id, weight: 1.0, ...by })))
      .execute();

    const session = await trx
      .insertInto('sessions')
      .values({
        event_id: event.id,
        name: 'Saturday Morning — Main Stage',
        stage: 'Main Stage',
        panel_id: panel.id,
        scheduled_start: new Date('2026-09-12T09:00:00+05:30'),
        scheduled_end: new Date('2026-09-12T13:00:00+05:30'),
        status: 'DRAFT',
        ...by,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('session_items')
      .values(
        [soloSong, groupSong].map((itemId, index) => ({
          session_id: session.id,
          item_id: itemId,
          display_order: index,
          ...by,
        })),
      )
      .execute();

    console.log('    Event:        PYPA Demo Event 2026 (active)');
    console.log(`    Churches:     ${churches.length}`);
    console.log(`    Categories:   ${categories.length}`);
    console.log(`    Items:        ${items.length}`);
    console.log(`    Members:      ${members.length}`);
    console.log(`    Judges:       ${judges.length} (username judge1/judge2/judge3, password ${judgePassword})`);
    console.log(`    Coordinator:  coordinator / ${judgePassword} (id ${coordinator.id.slice(0, 8)})`);
    console.log('    Session:      "Saturday Morning — Main Stage" (DRAFT — open it to begin judging)');
    console.log('');
    console.log('    The Solo Song — Junior Girls entrants reproduce the FSD 7.5 worked example:');
    console.log('      118 Sarah John (Zion) · 104 Anna Mathew (Bethel)');
    console.log('      132 Rebecca Thomas (Calvary) · 145 Grace Varghese (Bethel)');
    console.log('    Enter 9/8/9, 8.5/9/8.5, 7.5/8/7 and 6.5/7/6.5 to reproduce the published table.');
  });
}

main()
  .catch((error) => {
    console.error('\nSeeding failed:\n', error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
