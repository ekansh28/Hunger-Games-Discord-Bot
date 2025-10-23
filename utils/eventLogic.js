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
            { type: 'bloodbath', title: 'The Bloodbath', subtitle: 'As the tributes stand on their podiums, the horn sounds.', events: bloodbathEvents.events }
        ];
    }

    getCurrentStage() {
        return this.stages[this.currentStageIndex] || null;
    }

    getEventsForCurrentStage() {
        const stage = this.getCurrentStage();
        if (!stage) return [];

        this.stageDeaths = [];
        const aliveParticipants = Array.from(this.participants.values()).filter(p => p.alive);
        const events = [];
        const usedParticipants = new Set();

        // Calculate events needed to include most participants
        const minEvents = Math.max(6, Math.ceil(aliveParticipants.length / 2));
        const maxEvents = Math.min(20, aliveParticipants.length);

        // First pass: try to include as many participants as possible
        for (let i = 0; i < maxEvents && this.getAliveCount() > 1; i++) {
            const event = this.generateRandomEventWithPreference(stage.events, aliveParticipants, usedParticipants);
            if (event) {
                events.push(event);
                // Track which participants were used
                event.participants.forEach(p => usedParticipants.add(p.username));
            }
        }

        // Second pass: fill remaining slots if we haven't reached minimum
        while (events.length < minEvents && this.getAliveCount() > 1) {
            const event = this.generateRandomEvent(stage.events, aliveParticipants);
            if (event) {
                events.push(event);
            } else {
                break;
            }
        }

        return events;
    }

    generateRandomEvent(eventPool, aliveParticipants) {
        const currentAlive = aliveParticipants.filter(p => p.alive);
        if (currentAlive.length === 0) return null;

        const availableEvents = eventPool.filter(event => {
            const requiredParticipants = this.getRequiredParticipantCount(event);
            return currentAlive.length >= requiredParticipants;
        });

        if (availableEvents.length === 0) return null;

        const selectedEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)];
        const requiredCount = this.getRequiredParticipantCount(selectedEvent);

        const shuffledParticipants = [...currentAlive].sort(() => 0.5 - Math.random());
        const eventParticipants = shuffledParticipants.slice(0, requiredCount);

        const processedEvent = this.processEvent(selectedEvent, eventParticipants);

        if (selectedEvent.fatality) {
            this.handleFatalities(selectedEvent, eventParticipants);
        }

        return processedEvent;
    }

    generateRandomEventWithPreference(eventPool, aliveParticipants, usedParticipants) {
        const currentAlive = aliveParticipants.filter(p => p.alive);
        if (currentAlive.length === 0) return null;

        // Prioritize unused participants
        const unusedParticipants = currentAlive.filter(p => !usedParticipants.has(p.username));
        const participantsToUse = unusedParticipants.length > 0 ? unusedParticipants : currentAlive;

        const availableEvents = eventPool.filter(event => {
            const requiredParticipants = this.getRequiredParticipantCount(event);
            return participantsToUse.length >= requiredParticipants;
        });

        if (availableEvents.length === 0) return null;

        const selectedEvent = availableEvents[Math.floor(Math.random() * availableEvents.length)];
        const requiredCount = this.getRequiredParticipantCount(selectedEvent);

        // Prioritize unused participants in selection
        const shuffledParticipants = [...participantsToUse].sort(() => 0.5 - Math.random());
        const eventParticipants = shuffledParticipants.slice(0, requiredCount);

        const processedEvent = this.processEvent(selectedEvent, eventParticipants);

        if (selectedEvent.fatality) {
            this.handleFatalities(selectedEvent, eventParticipants);
        }

        return processedEvent;
    }

    getRequiredParticipantCount(event) {
        if (event.type === 'solo') return 1;
        if (event.type === 'duel') return 2;
        if (event.type === 'team') {
            const nameMatches = event.text.match(/\{name\d*\}/g);
            return nameMatches ? nameMatches.length : 3;
        }
        return 1;
    }

    processEvent(event, participants) {
        let text = event.text;
        const eventParticipants = [];

        participants.forEach((participant, index) => {
            const namePattern = index === 0 ? '{name}' : `{name${index + 1}}`;
            const displayName = participant.displayName || participant.username;
            text = text.replace(new RegExp(namePattern.replace(/[{}]/g, '\\$&'), 'g'), displayName);
            eventParticipants.push({
                username: participant.username,
                displayName: displayName,
                avatarURL: participant.avatarURL
            });
        });

        // Check for any remaining unreplaced name placeholders and log warning
        const remainingPlaceholders = text.match(/\{name\d*\}/g);
        if (remainingPlaceholders) {
            console.warn(`Event text still contains unreplaced placeholders: ${remainingPlaceholders.join(', ')} in "${event.text}"`);
        }

        return {
            text,
            participants: eventParticipants,
            original: event
        };
    }

    handleFatalities(event, participants) {
        if (event.type === 'solo') {
            this.killParticipant(participants[0]);
        } else if (event.type === 'duel') {
            if (event.killer !== undefined) {
                if (event.killer === 0) {
                    this.killParticipant(participants[1]);
                } else if (event.killer === 1) {
                    this.killParticipant(participants[0]);
                } else if (event.killer === -1) {
                    const randomVictim = Math.random() < 0.5 ? participants[0] : participants[1];
                    this.killParticipant(randomVictim);
                }
            }
        } else if (event.type === 'team') {
            if (event.killers && event.killers.length > 0) {
                participants.forEach((participant, index) => {
                    if (!event.killers.includes(index)) {
                        this.killParticipant(participant);
                    }
                });
            } else if (event.killer === -1) {
                const survivorIndex = Math.floor(Math.random() * participants.length);
                participants.forEach((participant, index) => {
                    if (index !== survivorIndex) {
                        this.killParticipant(participant);
                    }
                });
            }
        }
    }

    killParticipant(participant) {
        for (const [userId, userData] of this.participants.entries()) {
            if (userData.username === participant.username) {
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

            const shouldHaveSpecialEvent = this.shouldTriggerSpecialEvent(aliveCount);

            if (shouldHaveSpecialEvent.type === 'feast') {
                this.gamePhase = 'feast';
                this.stages.push({
                    type: 'feast',
                    title: 'The Feast',
                    subtitle: 'The Cornucopia is replenished with food, supplies, weapons, and memoirs from the tributes\' families.',
                    events: feastEvents.events
                });
            } else if (shouldHaveSpecialEvent.type === 'arena') {
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

    shouldTriggerSpecialEvent(aliveCount) {
        if (aliveCount <= 6 && this.dayNumber >= 3 && Math.random() < 0.6) {
            return { type: 'feast' };
        }

        if (aliveCount <= 8 && this.dayNumber >= 2 && Math.random() < 0.4) {
            return { type: 'arena' };
        }

        if (aliveCount <= 4 && this.dayNumber >= 4 && Math.random() < 0.7) {
            return { type: Math.random() < 0.5 ? 'feast' : 'arena' };
        }

        return { type: 'normal' };
    }

    getAliveCount() {
        return Array.from(this.participants.values()).filter(p => p.alive).length;
    }

    getWinner() {
        const aliveParticipants = Array.from(this.participants.values()).filter(p => p.alive);
        return aliveParticipants.length === 1 ? aliveParticipants[0] : null;
    }

    getAllParticipants() {
        return this.participants;
    }

    getDeadParticipants() {
        return this.deadParticipants;
    }
}

module.exports = EventLogic;