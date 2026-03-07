// Monitoring API for RelayMesh Dashboard
// Provides real-time topology and metrics data

const express = require('express');
const cors = require('cors');

/**
 * Create monitoring API router
 * @param {RelayMeshServer} server - The RelayMesh server instance
 * @returns {express.Router} Express router with monitoring endpoints
 */
function createMonitoringAPI(server) {
  const router = express.Router();

  // Enable CORS for dashboard
  router.use(cors());

  /**
   * GET /api/monitoring
   * Returns complete monitoring data including topology, metrics, and events
   */
  router.get('/monitoring', (req, res) => {
    try {
      const data = collectMonitoringData(server);
      res.json(data);
    } catch (error) {
      console.error('Error collecting monitoring data:', error);
      res.status(500).json({ error: 'Failed to collect monitoring data' });
    }
  });

  /**
   * GET /api/server-info
   * Returns server information
   */
  router.get('/server-info', (req, res) => {
    try {
      const info = server.getServerInfo();
      res.json(info);
    } catch (error) {
      console.error('Error getting server info:', error);
      res.status(500).json({ error: 'Failed to get server info' });
    }
  });

  return router;
}

/**
 * Collect complete monitoring data
 */
function collectMonitoringData(server) {
  const serverInfo = server.getServerInfo();

  // For now, return basic structure with mock data
  // This will be populated with real data once clients connect
  return {
    serverInfo: {
      activeConferences: serverInfo.activeConferences,
      totalParticipants: serverInfo.totalParticipants,
      uptime: serverInfo.uptime
    },
    conferences: [],
    participants: [],
    events: [
      {
        time: Date.now(),
        message: `Server started - ${serverInfo.activeConferences} conferences, ${serverInfo.totalParticipants} participants`
      }
    ]
  };
}

module.exports = { createMonitoringAPI };
