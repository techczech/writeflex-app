// Runs before any publication script: a fragment is consumed once and never persisted.
export const READER_RUNTIME_PERSON = String.raw`
var personCredential = new URLSearchParams(location.hash.slice(1)).get('p');
var personalLink = personCredential !== null;
if (personalLink) history.replaceState(null, '', location.pathname + location.search);
var loadId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
var personalName = '', personalOpeningRecorded = false;
if (personalLink || rp.hasAttribute('data-person-shell')) {
  try {
    var response = await fetch(location.pathname.replace(/\/$/, '') + '/content', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(personalLink ? { person: personCredential, loadId: loadId } : { reader: 'A'.repeat(43) }),
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
    });
    if (!response.ok) {
      if (response.status === 404) { var offPage = new DOMParser().parseFromString(await response.text(), 'text/html'); document.title = offPage.title; rp.replaceWith(offPage.body.firstElementChild); }
      else { rp.textContent = 'The text could not be loaded. Open your original link again to retry.'; }
      return;
    }
    var answer = await response.json();
    personalOpeningRecorded = answer.openingRecorded === true;
    personalName = answer.person && answer.person.name || '';
    var parsedPage = new DOMParser().parseFromString(answer.html, 'text/html');
    document.title = parsedPage.title;
    document.head.querySelectorAll('style').forEach(function (s) { s.remove(); });
    parsedPage.head.querySelectorAll('style').forEach(function (s) { document.head.appendChild(s); });
    rp.replaceWith(parsedPage.body.firstElementChild);
    rp = document.body.firstElementChild;
  } catch (error) { rp.textContent = 'The text could not be loaded. Open your original link again to retry.'; return; }
}
`
