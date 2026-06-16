// ============================================================
// authorization.js — shared "authorized to host" store
//
// Anyone added via =addp (user or role) is authorized to:
//   - host Hunger Games (=play)
//   - host Ban Roulette (/br)
// This is shared between index.js and banRoulette.js so both
// commands stay in sync automatically.
// ============================================================

'use strict';

const authorizedUsers = new Set([process.env.AUTHORIZED_USER_ID]);
const authorizedRoles = new Set();

function isAuthorized(memberOrUser) {
    if (!memberOrUser) return false;
    const userId = memberOrUser.id || memberOrUser.user?.id;
    if (authorizedUsers.has(userId)) return true;
    if (memberOrUser.roles && memberOrUser.roles.cache) {
        return memberOrUser.roles.cache.some(role => authorizedRoles.has(role.id));
    }
    return false;
}

module.exports = { authorizedUsers, authorizedRoles, isAuthorized };
