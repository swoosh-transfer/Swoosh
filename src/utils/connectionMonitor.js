let monitorInterval = null;

/**
 * Starts periodic polling of WebRTC statistics.
 * @param {RTCPeerConnection} pc - The active peer connection.
 * @param {Function} onStats - Callback receiving { rtt, packetLoss }.
 */
function startHealthMonitoring(pc, onStats) {
  if (monitorInterval) clearInterval(monitorInterval);

  // Poll stats every 1000ms
  monitorInterval = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;

    try {
      const stats = await pc.getStats();
      let rtt = 0;
      let packetsLost = 0;
      let packetsTotal = 0;

      stats.forEach(report => {
        // Calculate Round Trip Time from candidate pair
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime * 1000; // convert to ms
        }
        
        // Calculate Packet Loss from inbound RTP
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          packetsLost = report.packetsLost;
          packetsTotal = report.packetsReceived + report.packetsLost;
        }
      });

      const packetLossPct = packetsTotal > 0 ? ((packetsLost / packetsTotal) * 100).toFixed(2) : 0;

      if (onStats) {
        onStats({ 
          rtt: Math.round(rtt), 
          packetLoss: packetLossPct 
        });
      }

    } catch (err) {
      console.error("Stats monitoring error:", err);
    }
  }, 1000);
}

/**
 * Stops the monitoring interval.
 */
function stopHealthMonitoring() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
}

export { startHealthMonitoring, stopHealthMonitoring}