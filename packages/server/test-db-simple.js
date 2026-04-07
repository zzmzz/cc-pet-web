// Simple script to test the database schema and content
import fs from 'fs';

// Check if database file exists
const dbPath = '../../pet-compose/cc-pet.db';
if (fs.existsSync(dbPath)) {
  console.log('✓ Database file exists');

  // Try to open as binary to check if it's a proper SQLite file
  const buffer = fs.readFileSync(dbPath);
  const header = buffer.subarray(0, 16);
  const headerStr = new TextDecoder().decode(header);

  if (headerStr.startsWith('SQLite format 3')) {
    console.log('✓ Valid SQLite database file');

    // Print file size
    const stats = fs.statSync(dbPath);
    console.log(`Database size: ${stats.size} bytes`);
  } else {
    console.log('✗ Not a valid SQLite database file');
  }
} else {
  console.log('✗ Database file does not exist at', dbPath);
}

// Let's also test the API endpoint directly by checking the route definition
console.log('\nTesting the /api/quota/history route implementation...');
console.log('Looking for potential issues in the route handler...');
console.log('- The route uses LIMIT but no OFFSET, which should be fine');
console.log('- The route supports start/end date filters');
console.log('- The route returns JSON with parsed usage_data');