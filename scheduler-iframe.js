// scheduler-iframe.js
// Runs inside the extension iframe context to spawn a Web Worker exempt from the page CSP

try {
    const workerCode = `
        setInterval(() => {
            postMessage('tick');
        }, 1000);
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = () => {
        // Send tick message up to the parent window
        window.parent.postMessage({
            source: 'fchat-autoposter-iframe',
            action: 'SCHEDULER_TICK'
        }, '*');
    };
    console.log("F-Chat AutoPoster: Background Web Worker running in extension iframe.");
} catch (e) {
    console.error("F-Chat AutoPoster: Failed to start worker in iframe:", e);
}
