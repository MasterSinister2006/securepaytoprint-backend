const fs = require("fs");

let queue = [];

function addToQueue(job) {
  queue.push(job);
  processQueue();
}

function processQueue() {
  if (queue.length === 0) return;

  const job = queue.shift();
 console.log("Printing job for Token:", job.token);


  setTimeout(() => {
    fs.unlink(job.filePath, () => {
      console.log("File deleted after printing:", job.filePath);
    });
   console.log("Print completed for Token:", job.token);

  }, 10000);
}

module.exports = { addToQueue };
