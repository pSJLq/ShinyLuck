// Hit Shannon Explorer's getLogs REST endpoint the same way the frontend
// does to see what it returns for our HM events. If it returns 0 logs
// → Shannon indexer has a delay/issue. If it returns logs → the frontend
// fetchLogs parses them wrong.
const m = JSON.parse(require("fs").readFileSync("deployments/somniaTestnet.json", "utf8"));
const addr = m.addresses.houseManager;
const topic0 = "0xe4fb372c57b030e3d18ffc54319b5cf66954a0ec69cf65f9e0663f00c60b6c66"; // RtpAnalysisRequested

async function main() {
  const fromBlock = 393456000;
  const toBlock = 393483800;
  const url = `https://shannon-explorer.somnia.network/api?module=logs&action=getLogs&address=${addr}&fromBlock=${fromBlock}&toBlock=${toBlock}&topic0=${topic0}`;
  console.log(`URL: ${url}\n`);
  const r = await fetch(url);
  console.log(`HTTP ${r.status} ${r.statusText}`);
  const j = await r.json();
  console.log(`Response status: ${j.status}, message: ${j.message}`);
  console.log(`Result count: ${Array.isArray(j.result) ? j.result.length : "not array"}`);
  if (Array.isArray(j.result) && j.result.length > 0) {
    console.log(`First entry topics: ${j.result[0].topics?.join(', ')}`);
    console.log(`First entry block: ${j.result[0].blockNumber}`);
  } else if (j.result && typeof j.result === "string") {
    console.log(`Result (string): ${j.result.slice(0, 200)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
