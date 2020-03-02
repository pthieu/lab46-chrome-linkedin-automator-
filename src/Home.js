import React, { useEffect, useState } from 'react';
import { Button, Paper } from '@material-ui/core';
// import { makeStyles } from '@material-ui/core/styles';
// eslint-disable-next-line
import * as chromeAsync from 'chrome-extension-async';

const SCRAPE_INTERVAL = 2000;
const PROFILE_VISIT_INTERVAL = 4000;
const RAW_LINKS_KEY = 'rawLinks';
const VISIT_PROFILE_KEY = 'visitProfile';
const REVISIT_IGNORE_DURATION = 7 * 24 * 60 * 60 * 1000;

async function clearLinks() {
  // eslint-disable-next-line
  await chrome.storage.local.set({
    [RAW_LINKS_KEY]: {},
    [VISIT_PROFILE_KEY]: {},
  });
}

async function getLinks({ key = RAW_LINKS_KEY } = {}) {
  // eslint-disable-next-line
  let data = await chrome.storage.local.get([key]);
  if (Object.keys(data).length <= 0) {
    const initData = { [key]: {} };
    // eslint-disable-next-line
    await chrome.storage.local.set(initData);
    data = initData;
  }
  return data[key];
}

async function appendLinks({ key = RAW_LINKS_KEY, links } = {}) {
  // eslint-disable-next-line
  const data = await chrome.storage.local.get([key]);
  const allLinks = data[key] || {};

  links.map((l) => {
    const date = allLinks[l];
    if (!date) {
      // XXX(Phong): I fucked up, I want to be able to not revisit links that
      // have been visited already (within the REVISIT_IGNORE_DURATION time)
      // but the data structure can't handle it right now so we have to just
      // subtract it from the scrape time.
      allLinks[l] = Date.now() - REVISIT_IGNORE_DURATION;
    }
  });
  // eslint-disable-next-line
  await chrome.storage.local.set({ [key]: allLinks });
}

async function scrapePage() {
  // eslint-disable-next-line
  const tabs = await chrome.tabs.query({
    url: '*://*.linkedin.com/search/results/people/*',
  });
  const activeTab = tabs[0];

  // eslint-disable-next-line
  await chrome.tabs.executeScript(activeTab.id, {
    code: `(${scrollToBottom})()`,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, SCRAPE_INTERVAL);
  });

  // eslint-disable-next-line
  const results = await chrome.tabs.executeScript(activeTab.id, {
    code: `(${getLinkedInHrefs})()`,
  });

  const hrefs = results[0];
  await appendLinks({ links: hrefs });

  // eslint-disable-next-line
  const nextRes = await chrome.tabs.executeScript(activeTab.id, {
    code: `(${clickNext})()`,
  });
  return nextRes[0];
}

async function visitNextProfile() {
  const data = await getVisitProfileData();

  const { links = [], currentIndex } = data;

  if (currentIndex >= links.length || links.length <= 0) {
    return -1;
  }

  const goToLink = links[currentIndex];
  data.currentIndex++;

  await setVisitProfileData(data);
  // XXX(Phong): this happens even if you're not focused on the chrome app
  // eslint-disable-next-line
  chrome.windows.create(
    {
      // eslint-disable-next-line
      url: goToLink,
      type: 'popup',
      focused: false,
      height: 500,
      width: 500,
    },
    async (w) => {
      const newTabId = w.tabs[0].id;
      // eslint-disable-next-line
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (info.status === 'complete' && tabId === newTabId) {
          // eslint-disable-next-line
          chrome.tabs.onUpdated.removeListener(listener);
          // eslint-disable-next-line
          chrome.tabs.executeScript(w.tabs[0].id, {
            code: `(window.close())()`,
          });
        }
      });
      await updateProfileVisitTime(goToLink);
    },
  );
}

async function generateVisitLinks() {
  const rawLinks = await getLinks();

  const links = Object.entries(rawLinks).reduce((acc, [link, ts]) => {
    if (Date.now() - ts > REVISIT_IGNORE_DURATION) {
      acc.push(link);
    }
    return acc;
  }, []);

  // eslint-disable-next-line
  await chrome.storage.local.set({
    [VISIT_PROFILE_KEY]: {
      links,
      currentIndex: 0,
    },
  });

  return links;
}

async function updateProfileVisitTime(link) {
  const rawLinks = await getLinks();
  rawLinks[link] = Date.now();
  // eslint-disable-next-line
  await chrome.storage.local.set({
    rawLinks,
  });
}

async function getVisitProfileData() {
  // eslint-disable-next-line
  return (await chrome.storage.local.get([VISIT_PROFILE_KEY]))[
    VISIT_PROFILE_KEY
  ];
}

async function setVisitProfileData(data) {
  // eslint-disable-next-line
  await chrome.storage.local.set({
    [VISIT_PROFILE_KEY]: data,
  });
}

// Chrome Injected Code
function scrollToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
}

function getLinkedInHrefs() {
  const hrefList = [];
  const list = document.querySelectorAll(
    '.search-result__info a.search-result__result-link',
  );
  list.forEach((node) => {
    hrefList.push(node.href);
  });
  return hrefList;
}

function clickNext() {
  const node = document.querySelector('.artdeco-pagination__button--next');
  node.click();
  return node.disabled ? -1 : 0;
}

function Home() {
  const [state, setState] = useState({ linkCount: 0 });
  const [scrapeRunning, setScrapeRunning] = useState(false);
  const [scrapeJobId, setScrapeJobId] = useState(null);
  const [profileVisit, setProfileVisit] = useState({
    running: false,
    jobId: null,
  });

  async function toggleScrapePage() {
    if (!scrapeRunning) {
      const jobId = setInterval(async () => {
        const res = await scrapePage();
        if (res === -1) {
          return clearScapePage(jobId);
        }
      }, SCRAPE_INTERVAL);
      setScrapeJobId(jobId);
    } else {
      await clearScapePage();
    }

    setScrapeRunning(!scrapeRunning);
  }

  async function clearScapePage(jobId) {
    clearInterval(scrapeJobId || jobId);
    setScrapeJobId(null);
    setScrapeRunning(false);
  }

  async function toggleProfileVisits() {
    let links = (await generateVisitLinks()) || [];

    if (links.length <= 0) {
      return;
    }

    if (!profileVisit.running) {
      const jobId = setInterval(async () => {
        const res = await visitNextProfile();
        if (res === -1) {
          links = (await generateVisitLinks()) || [];
          if (links.length <= 0) {
            return clearProfileVisits(jobId);
          }
        }
      }, PROFILE_VISIT_INTERVAL);
      setProfileVisit({
        ...profileVisit,
        running: true,
        jobId,
      });
    } else {
      await clearProfileVisits();
    }
  }

  async function clearProfileVisits(jobId) {
    clearInterval(profileVisit.jobId || jobId);
    setProfileVisit({
      ...profileVisit,
      running: false,
      jobId: null,
    });
  }

  useEffect(() => {
    async function init() {
      const links = await getLinks();
      const linkCount = Object.keys(links).length;
      setState({ ...state, linkCount });
    }
    init();
  }, []);

  return (
    <div>
      <Paper>
        <div>
          <Button
            variant="contained"
            color="primary"
            onClick={toggleScrapePage}
          >
            {scrapeRunning ? 'Stop Scraping' : 'Start Scraping'}
          </Button>
        </div>
        <div>
          <Button variant="contained" color="secondary" onClick={clearLinks}>
            Clear
          </Button>
        </div>
        <div>
          <Button
            variant="contained"
            color="primary"
            onClick={toggleProfileVisits}
          >
            {profileVisit.running ? 'Stop Visits' : 'Start Visits'}
          </Button>
        </div>
      </Paper>
      <Paper>
        <div>Link Count: {state.linkCount}</div>
        <div>Running Scrape: {String(scrapeRunning)}</div>
        <div>Running Profile Visits: {String(profileVisit.running)}</div>
      </Paper>
    </div>
  );
}

export default Home;
