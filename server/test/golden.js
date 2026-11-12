// The classification golden table: [tool name, annotations, expected class]. docs/classification.md is generated from it.
export const GOLDEN = [
  ['listApplications', undefined, 'read'], ['getUser', undefined, 'read'], ['readEnvironment', undefined, 'read'],
  ['searchUsers', undefined, 'read'], ['describeEnvironment', undefined, 'read'],
  ['createUser', undefined, 'write'], ['updateApplication', undefined, 'write'], ['patchUser', undefined, 'write'], ['putGrants', undefined, 'write'],
  ['setPolicy', undefined, 'write'], ['addMember', undefined, 'write'], ['assignRole', undefined, 'write'], ['enableUser', undefined, 'write'],
  ['disableUser', undefined, 'write'], ['resetUserPassword', undefined, 'write'], ['unlockUser', undefined, 'write'], ['revokeSession', undefined, 'write'], ['importUsers', undefined, 'write'],
  ['deleteUser', undefined, 'destructive'], ['removeMember', undefined, 'destructive'], ['purgeData', undefined, 'destructive'], ['wipeEnvironment', undefined, 'destructive'], ['destroyKey', undefined, 'destructive'],
  ['frobnicateWidgets', undefined, 'write'], ['users_list', undefined, 'write'], // unknown verb position = write
  ['getOrCreateUser', undefined, 'write'], ['listThenDeleteUsers', undefined, 'destructive'],
  ['delete_user', undefined, 'destructive'], ['list_users', undefined, 'read'],
  // annotations
  ['frobnicate', { readOnlyHint: true }, 'write'], ['frobnicate', { destructiveHint: true }, 'destructive'], ['getThing', { readOnlyHint: false }, 'write'],
  ['deleteUser', { readOnlyHint: true }, 'destructive'], // a lying annotation does not open a write path
  ['users_delete', { readOnlyHint: true }, 'destructive'], ['users_create', { readOnlyHint: true }, 'write'], ['usersDelete', { readOnlyHint: true }, 'destructive'], ['user_remove_all', { readOnlyHint: true }, 'destructive'],
  ['createUser', { readOnlyHint: true }, 'write'], ['listUsers', { readOnlyHint: true }, 'read'], ['updateX', { destructiveHint: false }, 'write'],
];
