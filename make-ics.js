'use strict';

/**
 * Builds public/ignite-los-barriles.ics — the shareable trip calendar.
 *
 * Everyone imports the same file once and their own calendar app handles the
 * reminders from then on, so nobody needs to re-read the itinerary to know
 * that bootcamp starts in 45 minutes.
 *
 * Run after any itinerary change:
 *
 *   node make-ics.js
 *
 * This is a build-time tool. It is deliberately not copied into the Docker
 * image: the server stays dependency-free and serves the generated file as a
 * static asset.
 */

const fs = require('fs');
const path = require('path');

// Baja California Sur sits on permanent UTC-7 — it stopped observing DST in
// 2022 — so the zone has a single STANDARD block and no transition rules.
const TZID = 'America/Mazatlan';

// Bumped whenever an event's details change, so a re-import updates the
// existing entry instead of creating a duplicate alongside it.
const SEQUENCE = 0;

// A fixed stamp keeps regenerated files byte-identical when nothing changed,
// which makes it obvious in a diff whether the itinerary actually moved.
const DTSTAMP = '20261014T000000Z';

const LOCATIONS = {
  house: 'Casa Afortunada, Los Barriles, Baja California Sur, Mexico',
  courts: 'Tres Palapas Baja Pickleball Resort, Los Barriles, BCS, Mexico',
  airport: 'Los Cabos International Airport (SJD), San José del Cabo, Mexico',
};

/**
 * The week, as events.
 *
 * `allDay` events take a plain date; timed events take local wall-clock times
 * in the TZID above. `alarms` are ISO durations before the start: -PT45M is 45
 * minutes before, -PT15H on an all-day event lands at 9:00 AM the day before.
 */
const EVENTS = [
  {
    uid: 'arrival',
    summary: '✈️ Arrival day — SJD → Casa Afortunada',
    allDay: '2026-10-25',
    location: LOCATIONS.airport,
    description: [
      'Fly into Los Cabos (SJD), then a private Sprinter van transfer to the house.',
      '',
      'Most guests: Southwest WN630, SNA → SJD.',
      'Ryan: American AA2547, DFW → SJD.',
      '',
      'Transfer: RC Five Star Sedans & Limos, WhatsApp +52 624 205 4240.',
      'Host: Nicolas Radisay, 949 338 0792.',
      '',
      'Bring your passport and have pesos for tips.',
    ],
    alarms: ['-PT15H'],
  },
  {
    uid: 'welcome-dinner',
    summary: '🌮 Welcome Dinner — Chef Lupi',
    start: '2026-10-25T18:00',
    end: '2026-10-25T21:00',
    location: LOCATIONS.house,
    description: [
      'Chef Lupi opens the week at the house.',
      '',
      'Green chicken enchiladas, chiles rellenos, chicken tacos, rice, beans,',
      'guacamole, pico de gallo and tortilla chips.',
      '',
      'Attire: Baja casual.',
    ],
    alarms: ['-PT1H', '-P1D'],
  },

  ...bootcampDay(1, '2026-10-26'),
  ...bootcampDay(2, '2026-10-27'),

  {
    uid: 'free-day',
    summary: '🏖️ Free day — optional excursions',
    allDay: '2026-10-28',
    location: 'Los Barriles, Baja California Sur, Mexico',
    description: [
      'No meals or activities included — the flex day of the week.',
      '',
      'Ideas: sport fishing, a Cabo Pulmo snorkel trip, RZR runs up the arroyos,',
      'extra pickleball at Palmas Pickleball Resort, or nothing at all by the pool.',
      '',
      'Dinner is on your own. Book excursions ahead — ask your hosts for help.',
    ],
    alarms: ['-PT15H'],
  },

  ...bootcampDay(3, '2026-10-29'),

  // Friday keeps the morning session but hands the evening to the fiesta, so
  // it gets no separate social-play event.
  {
    uid: 'bootcamp-4',
    summary: '🥒 Bootcamp Day 4 — Tres Palapas',
    start: '2026-10-30T08:00',
    end: '2026-10-30T11:00',
    location: LOCATIONS.courts,
    description: [
      'Final morning session with Nic and "Baja" Joe, 8:00–11:00 AM.',
      '',
      'Hosted Mexican brunch at Tres Palapas right after, then afternoon social',
      'play before the fiesta.',
      '',
      'Bring: paddle, court shoes, hat, sunglasses, electrolytes, and more water',
      'than you think you need.',
    ],
    alarms: ['-PT45M'],
  },
  {
    uid: 'dia-de-los-muertos-dinner',
    summary: '💀 Día de los Muertos Dinner — Chef Rogelio + Pepon live',
    start: '2026-10-30T18:00',
    end: '2026-10-30T22:00',
    location: LOCATIONS.house,
    description: [
      'The big one. Five courses from Chef Rogelio Granado — appetizers, salad,',
      'Sonoran-style beef or catch of the day, sides and dessert — with live music',
      'from Pepon: classic rock, reggae, blues, and 80s to now.',
      '',
      'Attire: Día de los Muertos theme. Bring something festive — face paint,',
      'a floral crown, marigold colours, an embroidered shirt.',
    ],
    alarms: ['-PT1H', '-P1D'],
  },
  {
    uid: 'departure',
    summary: '✈️ Departure — Casa Afortunada → SJD',
    allDay: '2026-10-31',
    location: LOCATIONS.airport,
    description: [
      'Morning leisure, then the Sprinter van transfer back to SJD.',
      '',
      'Main group: Southwest WN631, SJD → SNA.',
      'Ryan: American AA1385, SJD → DFW.',
      'Brian & Shelly continue on to Cabo San Lucas.',
      '',
      'Allow plenty of time: SJD is about an hour from the house and the',
      'international terminal gets busy.',
    ],
    alarms: ['-PT15H'],
  },
];

/** The three identical bootcamp days: a morning session and evening social play. */
function bootcampDay(n, date) {
  return [
    {
      uid: 'bootcamp-' + n,
      summary: '🥒 Bootcamp Day ' + n + ' — Tres Palapas',
      start: date + 'T08:00',
      end: date + 'T11:00',
      location: LOCATIONS.courts,
      description: [
        'Intensive morning session with coaches Nic and "Baja" Joe, 8:00–11:00 AM.',
        '',
        'Hosted Mexican brunch at Tres Palapas right afterwards at 11:00.',
        '',
        'Bring: paddle, court shoes, hat, sunglasses, electrolytes, and more water',
        'than you think you need.',
      ],
      alarms: ['-PT45M'],
    },
    {
      uid: 'social-play-' + n,
      summary: '🥒 Social play — Tres Palapas',
      start: date + 'T17:00',
      end: date + 'T19:00',
      location: LOCATIONS.courts,
      description: [
        'Open social play, 5:00–7:00 PM. Optional but very much the fun part.',
        '',
        'Dinner afterwards is on your own — see the trip guide for recommendations.',
      ],
      alarms: ['-PT30M'],
    },
  ];
}

// ------------------------------------------------------------- formatting ---

/** Escape a TEXT value per RFC 5545 §3.3.11. Order matters: backslash first. */
function esc(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold to the 75-octet line limit (RFC 5545 §3.1).
 *
 * The limit counts octets, not characters, and this calendar is full of
 * multi-byte text — emoji, accented Spanish, en dashes — so the split has to
 * be measured in UTF-8 bytes and must never land inside a character.
 */
function fold(line) {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes <= 75) return line;

  const out = [];
  let current = '';
  let currentBytes = 0;
  // First line allows 75 octets; continuations spend one on the leading space.
  let limit = 75;

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  if (current) out.push(current);

  return out.join('\r\n ');
}

function dateOnly(isoDate) {
  return isoDate.replace(/-/g, '');
}

/**
 * "2026-10-25T18:00" -> "20261025T180000".
 *
 * A DATE-TIME is required to carry seconds; without them Apple Calendar
 * rejects the whole file rather than the one property.
 */
function localStamp(isoLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(isoLocal);
  if (!m) throw new Error('Bad local time "' + isoLocal + '" (want YYYY-MM-DDTHH:MM)');
  return m[1] + m[2] + m[3] + 'T' + m[4] + m[5] + '00';
}

/** The day after an all-day date, for the non-inclusive DTEND. */
function nextDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function alarmBlock(trigger, summary) {
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:' + trigger,
    'DESCRIPTION:' + esc(summary),
    'END:VALARM',
  ];
}

function eventBlock(ev) {
  const lines = [
    'BEGIN:VEVENT',
    'UID:' + ev.uid + '@losbarriles2026.ignitepickleball',
    'DTSTAMP:' + DTSTAMP,
    'SEQUENCE:' + SEQUENCE,
  ];

  if (ev.allDay) {
    lines.push('DTSTART;VALUE=DATE:' + dateOnly(ev.allDay));
    lines.push('DTEND;VALUE=DATE:' + nextDay(ev.allDay));
  } else {
    lines.push('DTSTART;TZID=' + TZID + ':' + localStamp(ev.start));
    lines.push('DTEND;TZID=' + TZID + ':' + localStamp(ev.end));
  }

  lines.push('SUMMARY:' + esc(ev.summary));
  lines.push('LOCATION:' + esc(ev.location));
  lines.push('DESCRIPTION:' + esc(ev.description.join('\n')));
  lines.push('STATUS:CONFIRMED');
  lines.push('TRANSP:OPAQUE');

  for (const trigger of ev.alarms || []) {
    lines.push(...alarmBlock(trigger, ev.summary));
  }

  lines.push('END:VEVENT');
  return lines;
}

function build() {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ignite Pickleball//Los Barriles Bootcamp 2026//EN',
    'CALSCALE:GREGORIAN',
    // Apple and Google both read these for the imported calendar's name.
    'X-WR-CALNAME:Los Barriles Bootcamp 2026',
    'X-WR-CALDESC:Ignite Pickleball bootcamp — Los Barriles\\, Oct 25–31\\, 2026',
    'X-WR-TIMEZONE:' + TZID,
    'BEGIN:VTIMEZONE',
    'TZID:' + TZID,
    'BEGIN:STANDARD',
    'DTSTART:20221030T010000',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0700',
    'TZNAME:MST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  for (const ev of EVENTS) lines.push(...eventBlock(ev));
  lines.push('END:VCALENDAR');

  // RFC 5545 requires CRLF line endings, including a trailing one.
  return lines.map(fold).join('\r\n') + '\r\n';
}

const target = path.join(__dirname, 'public', 'ignite-los-barriles.ics');
const ics = build();
fs.writeFileSync(target, ics, 'utf8');

console.log('Wrote ' + path.relative(__dirname, target) + ' — ' + EVENTS.length +
  ' events, ' + Buffer.byteLength(ics, 'utf8') + ' bytes.');
