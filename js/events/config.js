// Match events: small, once-per-match moments derived from authoritative game state. Definitions and every
// threshold live here so events are easy to retune and extend (a future achievement / mission system can
// subscribe to the same event ids). Nothing else hard-codes an event number.
//
//   prominence: 'major' events get a bigger toast; 'minor' are quiet milestones
//   toast:      shown as a toast during the match (final events are only listed in the results)
//   final:      decided when the match ends
export const MATCH_EVENTS = {
  first_blood: { name: 'First Blood', icon: '🩸', prominence: 'major', toast: true }, // first elimination of the match (once per match)
  food_hunter: { name: 'Food Hunter', icon: '🍎', prominence: 'minor', toast: true, food: 12 }, // this much normal food eaten
  power_collector: { name: 'Power Collector', icon: '⚡', prominence: 'minor', toast: true, powerups: 3 }, // Speed / Magnet / Shield / Mega pickups
  giant_snake: { name: 'Giant Snake', icon: '🐍', prominence: 'major', toast: true, length: 25 }, // reach this length
  survivor: { name: 'Survivor', icon: '🛡️', prominence: 'minor', toast: true, seconds: 60 }, // still alive after this long
  longest_snake: { name: 'Longest Snake', icon: '📏', prominence: 'minor', toast: false, final: true, minLength: 12 }, // longest at the end (must exceed minLength)
  most_food: { name: 'Most Food', icon: '🍽️', prominence: 'minor', toast: false, final: true, minFood: 4 }, // most normal food at the end
  // From the bottom third of the length ranking to first place, gaining at least minLengthGain segments.
  comeback: {
    name: 'Comeback', icon: '📈', prominence: 'major', toast: true,
    minPlayers: 3, lowRankFraction: 2 / 3, minLengthGain: 5, startAfterTicks: 60, sampleEveryTicks: 6,
  },
};

export const EVENT_IDS = Object.keys(MATCH_EVENTS);
export const isEventId = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(MATCH_EVENTS, id);

// Toast pacing: never a wall of banners.
export const EVENT_TOAST = { minorMs: 2200, majorMs: 3400, maxQueue: 3 };
