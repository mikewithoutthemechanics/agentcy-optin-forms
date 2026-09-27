/**
 * The frictionless forms switch the contact field between an email address, a
 * WhatsApp number and a LinkedIn URL by swapping the input's `type`.
 *
 * `setContactMethod` was only ever wired to the click handlers, never run on
 * page load, so the button marked `active` in the HTML and the actual field
 * could disagree. In production the online-SMB form shipped with WhatsApp
 * highlighted while the input was `type="email"` - so a visitor who trusted
 * the UI and typed a phone number was silently refused by the browser. No
 * error message, no request, the form just did nothing.
 *
 * These tests are static because the bug is in the markup/JS contract, and
 * asserting the initial type matches the active button catches the whole class
 * of it rather than one instance.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FORMS = [
  'trades-form-frictionless.html',
  'online-smb-form-frictionless.html',
  'prof-services-form-frictionless.html',
];

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** Every channel button: its element id, its data-channel, and whether it is active. */
function channelButtons(src) {
  return [...src.matchAll(/<button[^>]*id="btn-(\w+)"[^>]*>/g)].map((m) => {
    const tag = m[0];
    return {
      id: m[1],
      channel: (tag.match(/data-channel="([^"]+)"/) || [])[1] || null,
      active: /\bactive\b/.test((tag.match(/class="([^"]*)"/) || [])[1] || ''),
    };
  });
}

/** The `type` on the contact input as declared in the raw markup. */
function declaredType(src) {
  const m = src.match(/<input[^>]*\bid="contact"[^>]*>/);
  if (!m) return null;
  return (m[0].match(/type="(\w+)"/) || [])[1] || null;
}

/** The JS variable bound to a button id, e.g. btn-whatsapp -> whatsappBtn. */
function bindingFor(src, buttonId) {
  const m = src.match(
    new RegExp("const\\s+(\\w+)\\s*=\\s*document\\.getElementById\\('" + buttonId + "'\\)")
  );
  return m ? m[1] : null;
}

test('every frictionless form initialises its contact field on load', () => {
  for (const f of FORMS) {
    const src = read(f);
    assert.ok(
      src.includes('Initial channel: make the markup agree with itself'),
      `${f} never calls setContactMethod on load, so the active button and the input type can drift`
    );
    assert.ok(
      /setContactMethod\(\s*\w+\.classList\.contains\('active'\)/.test(src),
      `${f} must derive the initial channel from whichever button is active`
    );
  }
});

test('the declared input type matches the button marked active', () => {
  // The specific production bug: WhatsApp highlighted, type="email".
  for (const f of FORMS) {
    const src = read(f);
    const active = channelButtons(src).find((b) => b.active);
    const type = declaredType(src);
    assert.ok(active, `${f} has no active channel button`);
    assert.ok(type, `${f} has no contact input`);

    const expected =
      active.channel === 'WhatsApp' ? 'tel' :
      active.channel === 'LinkedIn' ? 'url' : 'email';

    assert.equal(
      type, expected,
      `${f} highlights "${active.channel}" but the input is type="${type}" - a visitor typing a ${
        active.channel === 'WhatsApp' ? 'phone number' : 'URL'
      } would be silently refused`
    );
  }
});

test('every channel button has a click handler', () => {
  for (const f of FORMS) {
    const src = read(f);
    const buttons = channelButtons(src);
    assert.ok(buttons.length >= 2, `${f} exposes only ${buttons.length} channel button(s)`);
    for (const b of buttons) {
      // channelButtons() strips the "btn-" prefix, so restore it for the lookup.
      const binding = bindingFor(src, `btn-${b.id}`);
      assert.ok(binding, `${f}: the "btn-${b.id}" button is never bound in JS`);
      assert.ok(
        src.includes(`${binding}.addEventListener('click'`),
        `${f}: the "btn-${b.id}" button has no click handler`
      );
    }
  }
});

test('setContactMethod sets type, placeholder and label for every branch', () => {
  // A channel that changes the type but not the placeholder still tells the
  // visitor to type an email into a phone field.
  for (const f of FORMS) {
    const src = read(f);
    const body = src.slice(
      src.indexOf('function setContactMethod('),
      src.indexOf('.addEventListener(\'click\'', src.indexOf('function setContactMethod('))
    );
    const branches = (body.match(/if \(method ===/g) || []).length + (body.match(/\} else \{/g) || []).length;
    assert.ok(branches >= 2, `${f}: setContactMethod should branch per channel`);
    for (const attr of ['contactInput.type', 'contactInput.placeholder', 'contactLabel.textContent']) {
      assert.ok(body.includes(attr), `${f}: setContactMethod never sets ${attr}`);
    }
  }
});
