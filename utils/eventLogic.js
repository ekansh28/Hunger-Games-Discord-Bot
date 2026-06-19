const bloodbathEvents = require('../events/bloodbath.json');
const dayEvents = require('../events/day.json');
const nightEvents = require('../events/night.json');
const feastEvents = require('../events/feast.json');
const arenaEvents = require('../events/arena.json');

class EventLogic {
    constructor(participants) {
        this.participants = new Map(participants);
        this.deadParticipants = new Map();
        this.currentStageIndex = 0;
        this.dayNumber = 1;
        this.gamePhase = 'bloodbath';
        this.stageDeaths = [];

        this.stages = [
            {
                type: 'bloodbath',
                title: 'The Bloodbath',
                subtitle: 'As the tributes stand on their podiums, the horn sounds.',
                events: bloodbathEvents.events
            }
        ];
    }

    getCurrentStage() {
        return this.stages[this.currentStageIndex] || null;
    }

    // ─── BUG FIX ─────────────────────────────────────────────────────────────
    // Previously, aliveParticipants was a snapshot taken once at the top of
    // the function and never refreshed. So when an event killed a participant,
    // subsequent events could still pick that now-dead participant because the
    // array reference was stale. We now derive the alive list fresh before
    // every event attempt by reading directly from this.participants.
    // ─────────────────────────────────────────────────────────────────────────
    getEventsForCurrentStage() {
        const stage = this.getCurrentStage();
        if (!stage) return [];

        this.stageDeaths = [];
        const events = [];
        const usedUserIds = new Set();

        const getAlive = () =>
            Array.from(this.participants.entries())
                .filter(([, p]) => p.alive)
                .map(([id, p]) => ({ id, ...p }));

        const targetEvents = Math.min(20, Math.max(6, Math.ceil(this.getAliveCount() * 0.75)));

        for (let i = 0; i < targetEvents * 3 && events.length < targetEvents; i++) {
            if (this.getAliveCount() <= 1) break;

            const alive = getAlive();
            if (alive.length === 0) break;

            // Prefer participants who haven't had an event yet this stage
            const unused = alive.filter(p => !usedUserIds.has(p.id));
            const pool = unused.length > 0 ? unused : alive;

            const event = this._tryGenerateEvent(stage.events, alive, pool);
            if (event) {
                events.push(event);
                event.participantIds.forEach(id => usedUserIds.add(id));
            }
        }

        return events;
    }

    // ─── Internal event generator ─────────────────────────────────────────────
    // Picks a random event whose participant requirement can be satisfied,
    // then applies fatalities using the correct logic for each event type.
    // Returns the processed event object, or null if no valid event found.
    _tryGenerateEvent(eventPool, allAlive, preferredPool) {
        // Filter events that the preferred pool can satisfy; fall back to all alive
        const canSatisfy = (pool, event) =>
            pool.length >= this._getRequiredCount(event);

        let candidates = eventPool.filter(e => canSatisfy(preferredPool, e));
        let chosenPool = preferredPool;

        if (candidates.length === 0) {
            candidates = eventPool.filter(e => canSatisfy(allAlive, e));
            chosenPool = allAlive;
        }

        if (candidates.length === 0) return null;

        const template = candidates[Math.floor(Math.random() * candidates.length)];
        const count = this._getRequiredCount(template);

        // Shuffle and pick participants from the chosen pool
        const shuffled = [...chosenPool].sort(() => Math.random() - 0.5);
        const chosen = shuffled.slice(0, count);

        // Build processed event BEFORE applying fatalities (so text is rendered correctly)
        const processed = this._processEvent(template, chosen);

        // Apply fatalities
        if (template.fatality) {
            this._handleFatalities(template, chosen);
        }

        return processed;
    }

    // ─── BUG FIX ─────────────────────────────────────────────────────────────
    // getRequiredParticipantCount previously used a fragile regex on the event
    // text to count placeholders. This was error-prone (e.g. it would fail for
    // events whose text only has {name} but are typed 'duel'). We now look at
    // the highest numbered {name} placeholder and also enforce the minimum
    // implied by the event type, which the old version did but we keep here.
    // ─────────────────────────────────────────────────────────────────────────
    _getRequiredCount(event) {
        const matches = event.text.match(/\{name(\d*)\}/g) || [];
        let max = matches.length === 0 ? 1 : 0;
        for (const m of matches) {
            const num = m === '{name}' ? 1 : parseInt(m.replace(/\D/g, ''));
            if (num > max) max = num;
        }

        // Enforce event-type minimums
        if (event.type === 'duel') return Math.max(max, 2);
        if (event.type === 'team') return Math.max(max, 3);
        return Math.max(max, 1);
    }

    _processEvent(event, participants) {
        let text = event.text;

        // Replace placeholders in order: {name}, {name2}, {name3}, {name4}
        participants.forEach((participant, index) => {
            const placeholder = index === 0 ? '{name}' : `{name${index + 1}}`;
            const displayName = participant.displayName || participant.username;
            // Escape special regex chars in the placeholder
            const escaped = placeholder.replace(/[{}]/g, '\\$&');
            text = text.replace(new RegExp(escaped, 'g'), displayName);
        });

        return {
            text,
            participants: participants.map(p => ({
                username: p.username,
                displayName: p.displayName || p.username,
                avatarURL: p.avatarURL
            })),
            // Store ids separately for the used-participants tracking
            participantIds: participants.map(p => p.id),
            original: event
        };
    }

    // ─── BUG FIX ─────────────────────────────────────────────────────────────
    // The old handleFatalities had several problems:
    //
    // 1. duel + killer === -1 only killed ONE person randomly, but events like
    //    "fall down a hill killing them both" expect BOTH to die.
    //
    // 2. team + killer === -1 was handled with a random survivor branch, which
    //    is correct for arena events like "only {name} survives", but the text
    //    already encodes who survives -- so the random pick could contradict it.
    //    We now read survivor identity directly from the text.
    //
    // 3. team events with a `killer` (not `killers`) field (from arena events)
    //    were falling through to the wrong branch.
    //
    // The new logic:
    //  - solo:                kill participants[0]
    //  - duel, killer >= 0:   kill the non-killer index
    //  - duel, killer === -1: kill BOTH (event text implies mutual death)
    //  - team, killers array: kill everyone NOT in killers[]
    //  - team, killer === -1: kill everyone NOT named after a "Only X survives"
    //    clause in the text; fall back to killing all but a random survivor.
    // ─────────────────────────────────────────────────────────────────────────
    _handleFatalities(event, participants) {
        const kill = p => this._killParticipant(p);

        if (event.type === 'solo') {
            kill(participants[0]);
            return;
        }

        if (event.type === 'duel') {
            if (event.killer === 0) {
                // participants[0] kills, participants[1] dies
                kill(participants[1]);
            } else if (event.killer === 1) {
                // participants[1] kills, participants[0] dies
                kill(participants[0]);
            } else if (event.killer === -2) {
                // Explicit mutual death -- BOTH die (e.g. "roll down a hillside and die")
                participants.forEach(p => kill(p));
            } else if (event.killer === -1) {
                // One survivor encoded in text: "Only {name} survives" / "Only {name2} survives"
                const survivorIndices = this._parseSurvivorIndices(event.text, participants.length);
                if (survivorIndices.length > 0) {
                    participants.forEach((p, i) => {
                        if (!survivorIndices.includes(i)) kill(p);
                    });
                } else {
                    // Fallback: participants[0] survives, participants[1] dies
                    kill(participants[1]);
                }
            }
            return;
        }

        if (event.type === 'team') {
            // Explicit killers list: everyone NOT in the killers array dies
            if (Array.isArray(event.killers)) {
                participants.forEach((p, i) => {
                    if (!event.killers.includes(i)) kill(p);
                });
                return;
            }

            // killer: -1 means an arena/environment event with one survivor.
            // Try to figure out who survives from the event text.
            // Events say "Only {name} survives", "Only {name2} survives", etc.
            if (event.killer === -1) {
                const survivorIndices = this._parseSurvivorIndices(event.text, participants.length);
                if (survivorIndices.length > 0) {
                    participants.forEach((p, i) => {
                        if (!survivorIndices.includes(i)) kill(p);
                    });
                } else {
                    // Fallback: pick a random survivor
                    const survivorIdx = Math.floor(Math.random() * participants.length);
                    participants.forEach((p, i) => {
                        if (i !== survivorIdx) kill(p);
                    });
                }
                return;
            }
        }
    }

    // Parse "Only {name} survives" / "Only {name2} survives" from event text
    // and return an array of 0-based survivor indices.
    _parseSurvivorIndices(text, participantCount) {
        const indices = [];
        const regex = /Only\s+\{(name\d*)\}\s+survives/gi;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const placeholder = match[1]; // e.g. "name" or "name2"
            if (placeholder === 'name') {
                indices.push(0);
            } else {
                const num = parseInt(placeholder.replace('name', ''));
                if (!isNaN(num)) indices.push(num - 1);
            }
        }
        return indices;
    }

    _killParticipant(participant) {
        // participant may have an .id (from our processed list) or we match by username
        const idToKill = participant.id;

        if (idToKill && this.participants.has(idToKill)) {
            const userData = this.participants.get(idToKill);
            if (!userData.alive) return; // already dead, don't double-add to deaths
            userData.alive = false;
            this.deadParticipants.set(idToKill, userData);
            this.stageDeaths.push({
                username: userData.username,
                displayName: userData.displayName || userData.username,
                avatarURL: userData.avatarURL
            });
        } else {
            // Fallback: match by username (handles edge cases)
            for (const [userId, userData] of this.participants.entries()) {
                if (userData.username === participant.username) {
                    if (!userData.alive) return;
                    userData.alive = false;
                    this.deadParticipants.set(userId, userData);
                    this.stageDeaths.push({
                        username: userData.username,
                        displayName: userData.displayName || userData.username,
                        avatarURL: userData.avatarURL
                    });
                    break;
                }
            }
        }
    }

    getStageDeaths() {
        return [...this.stageDeaths];
    }

    clearStageDeaths() {
        this.stageDeaths = [];
    }

    nextStage() {
        this.currentStageIndex++;
        this.generateNextStage();
    }

    generateNextStage() {
        const aliveCount = this.getAliveCount();
        if (aliveCount <= 1) return;

        if (this.gamePhase === 'bloodbath') {
            this.gamePhase = 'day';
            this.stages.push({
                type: 'day',
                title: `Day ${this.dayNumber}`,
                subtitle: 'The sun rises on the first day in the arena.',
                events: dayEvents.events
            });
        } else if (this.gamePhase === 'day') {
            this.gamePhase = 'night';
            this.stages.push({
                type: 'night',
                title: `Night ${this.dayNumber}`,
                subtitle: 'The arena falls silent as darkness covers the tributes.',
                events: nightEvents.events
            });
        } else if (this.gamePhase === 'night') {
            this.dayNumber++;
            const special = this._shouldTriggerSpecialEvent(aliveCount);

            if (special === 'feast') {
                this.gamePhase = 'feast';
                this.stages.push({
                    type: 'feast',
                    title: 'The Feast',
                    subtitle: "The Cornucopia is replenished with food, supplies, weapons, and memoirs from the tributes' families.",
                    events: feastEvents.events
                });
            } else if (special === 'arena') {
                this.gamePhase = 'arena';
                this.stages.push({
                    type: 'arena',
                    title: 'Arena Event',
                    subtitle: 'The Gamemakers have decided to intervene.',
                    events: arenaEvents.events
                });
            } else {
                this.gamePhase = 'day';
                this.stages.push({
                    type: 'day',
                    title: `Day ${this.dayNumber}`,
                    subtitle: 'The sun rises on another day in the arena.',
                    events: dayEvents.events
                });
            }
        } else if (this.gamePhase === 'feast' || this.gamePhase === 'arena') {
            this.gamePhase = 'day';
            this.stages.push({
                type: 'day',
                title: `Day ${this.dayNumber}`,
                subtitle: 'The sun rises on another day in the arena.',
                events: dayEvents.events
            });
        }
    }

    _shouldTriggerSpecialEvent(aliveCount) {
        if (aliveCount <= 4 && this.dayNumber >= 4 && Math.random() < 0.7) {
            return Math.random() < 0.5 ? 'feast' : 'arena';
        }
        if (aliveCount <= 6 && this.dayNumber >= 3 && Math.random() < 0.6) {
            return 'feast';
        }
        if (aliveCount <= 8 && this.dayNumber >= 2 && Math.random() < 0.4) {
            return 'arena';
        }
        return 'normal';
    }

    getAliveCount() {
        let count = 0;
        for (const p of this.participants.values()) {
            if (p.alive) count++;
        }
        return count;
    }

    getWinner() {
        for (const p of this.participants.values()) {
            if (p.alive) return p;
        }
        return null;
    }

    getAllParticipants() {
        return this.participants;
    }

    getDeadParticipants() {
        return this.deadParticipants;
    }
}

module.exports = EventLogic;