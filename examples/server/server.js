#!/usr/bin/env node

/**
 * RelayMesh Simple Server Example
 * 
 * A minimal signaling server for development and testing.
 * For production use, see the deployment guide.
 */

const { createServer } = require('../../dist/index.js');

async function main() {
  console.log('🚀 Starting RelayMesh Signaling Server...\n');

  // Configuration
  const config = {
    port: process.env.PORT || 8080,
    host: process.env.HOST || '0.0.0.0',
    tlsEnabled: process.env.TLS_ENABLED === 'true',
    tlsCertPath: process.env.TLS_CERT_PATH,
    tlsKeyPath: process.env.TLS_KEY_PATH,
    authRequired: process.env.AUTH_REQUIRED === 'true',
    maxConferences: parseInt(process.env.MAX_CONFERENCES || '100'),
    maxParticipantsPerConference: parseInt(process.env.MAX_PARTICIPANTS || '50')
  };

  // Create and start server
  try {
    const server = await createServer(config);

    console.log('✅ Server started successfully!\n');
    console.log('Configuration:');
    console.log(`  - Port: ${config.port}`);
    console.log(`  - Host: ${config.host}`);
    console.log(`  - TLS: ${config.tlsEnabled ? 'enabled' : 'disabled'}`);
    console.log(`  - Authentication: ${config.authRequired ? 'required' : 'optional'}`);
    console.log(`  - Max Conferences: ${config.maxConferences}`);
    console.log(`  - Max Participants: ${config.maxParticipantsPerConference}`);
    console.log('\n📡 Server URL:', config.tlsEnabled ? 'wss' : 'ws' + `://${config.host}:${config.port}`);
    console.log('\n💡 Press Ctrl+C to stop the server\n');

    // Monitor server status
    setInterval(() => {
      const status = server.getStatus();
      if (status.conferences > 0 || status.participants > 0) {
        console.log(`[${new Date().toLocaleTimeString()}] Active: ${status.conferences} conferences, ${status.participants} participants`);
      }
    }, 30000); // Log every 30 seconds if there's activity

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n\n⚠️  Received ${signal}, shutting down gracefully...`);
      
      try {
        await server.stop();
        console.log('✅ Server stopped successfully');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown('unhandledRejection');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Run server
main();
