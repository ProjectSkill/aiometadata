const express = require('express');
const { startServerWithCacheWarming } = require('./index.js');
const { initializeMapper } = require('./lib/id-mapper.js');
const { initializeAnimeListMapper } = require('./lib/anime-list-mapper.js');
const { initializeMappings } = require('./lib/wiki-mapper.js');
const { initializeRatings } = require('./lib/imdbRatings.js');
const { runCacheCleanup } = require('./cache-cleanup.js');
const { runCachePathMigration } = require('./lib/cache-path-migration.js');
const database = require('./lib/database.js');
const consola = require('consola');

// Configure logging level based on environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
consola.level = consola.LogLevels[logLevel.toLowerCase()] || (process.env.NODE_ENV === 'production' ? 3 : 4);

const PORT = parseInt(process.env.PORT || '3232', 10);

async function startServer() {
  consola.info('--- Addon Starting Up ---');

  process.on('uncaughtException', (error) => {
    consola.error('--- UNCAUGHT EXCEPTION ---');
    consola.error('Error:', error.message);
    consola.error('Stack:', error.stack);
    consola.error('This error was not caught and could crash the application.');
  });

  process.on('unhandledRejection', (reason, promise) => {
    consola.error('--- UNHANDLED PROMISE REJECTION ---');
    consola.error('Reason:', reason);
    consola.error('Promise:', promise);
    consola.error('This rejection was not handled and could crash the application.');
  });

  // Database must initialize first
  consola.info('Initializing Database...');
  await database.initialize();
  consola.success('Database initialization complete.');

  // Cache path migration
  consola.info('Running cache path migration...');
  await runCachePathMigration();
  consola.success('Cache path migration complete.');

  consola.info('Initializing Mappers, Ratings, and Cache Cleanup...');

  const initializationTasks = [
    {
      name: 'ID Mapper (anime-list.json)',
      task: async () => {
        consola.info('Initializing ID Mapper...');
        await initializeMapper();
      },
      critical: true
    },
    {
      name: 'Anime List Mapper (anime-list.xml)',
      task: async () => {
        consola.info('Initializing Anime List Mapper...');
        await initializeAnimeListMapper();
      },
      critical: true
    },
    {
      name: 'Wiki Mappings',
      task: async () => {
        consola.info('Initializing Wiki Mappings...');
        await initializeMappings();
      },
      critical: true
    },
    {
      name: 'IMDb Ratings',
      task: async () => {
        consola.info('Initializing IMDb Ratings...');
        await initializeRatings();
      },
      critical: true
    },
    {
      name: 'Cache Cleanup Check',
      task: async () => {
        consola.info('Checking for one-time cache cleanup...');
        await runCacheCleanup();
      },
      critical: false
    }
  ];

  // Execute all tasks in parallel
  const results = await Promise.allSettled(
    initializationTasks.map(({ task }) => task())
  );

  // Check results and log appropriately
  const failures = [];
  results.forEach((result, index) => {
    const { name, critical } = initializationTasks[index];
    if (result.status === 'fulfilled') {
      consola.success(`${name} initialization complete.`);
    } else {
      consola.error(`${name} failed to initialize:`, result.reason);
      if (critical) {
        failures.push(name);
      }
    }
  });

  // Abort startup if any critical tasks failed
  if (failures.length > 0) {
    throw new Error(`Critical initialization failures: ${failures.join(', ')}`);
  }

  consola.success('All initializations complete.');

  // PHASE 3: Start server with cache warming
  consola.info('Starting server with cache warming...');
  const addon = await startServerWithCacheWarming();

  // PHASE 4: Start background catalog warming (after server initialization)
  const { startMALWarmup } = require('./lib/malCatalogWarmer.js');
  startMALWarmup();

  const { startComprehensiveCatalogWarming } = require('./lib/comprehensiveCatalogWarmer.js');
  startComprehensiveCatalogWarming();

  addon.listen(PORT, () => {
    consola.success(`Addon active and listening on port ${PORT}.`);
    consola.info(`Open http://127.0.0.1:${PORT} in your browser.`);
  });
}

startServer().catch((error) => {
  consola.error('--- FATAL STARTUP ERROR ---');
  consola.error(error);
  process.exit(1);
});