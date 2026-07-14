#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const envFile = path.join(rootDir, '.env');
const envExample = path.join(rootDir, '.env.example');

console.log('🚀 Configer Setup');
console.log('================\n');

// Step 1: Check for .env file
if (!fs.existsSync(envFile)) {
  console.log('📋 Creating .env from .env.example...');
  fs.copyFileSync(envExample, envFile);
  console.log('✅ .env created. Please review and customize if needed.\n');
} else {
  console.log('✅ .env already exists\n');
}

// Step 2: Install dependencies
console.log('📦 Installing frontend dependencies...');
try {
  execSync('cd frontend && npm install', { stdio: 'inherit', cwd: rootDir });
  console.log('✅ Frontend dependencies installed\n');
} catch (error) {
  console.error('❌ Failed to install frontend dependencies');
  process.exit(1);
}

console.log('📦 Installing backend dependencies...');
try {
  execSync('cd backend && go mod download', { stdio: 'inherit', cwd: rootDir });
  console.log('✅ Backend dependencies installed\n');
} catch (error) {
  console.error('❌ Failed to install backend dependencies');
  process.exit(1);
}

// Step 3: Print next steps
console.log('🎉 Setup complete!\n');
console.log('Next steps:');
console.log('----------');
console.log('1. Review and customize .env file');
console.log('2. Run: npm start');
console.log('   - Frontend: http://localhost:5173');
console.log('   - Backend: http://localhost:8080');
console.log('   - API Docs: http://localhost:8080/api/docs');
console.log('\nOr use Docker:');
console.log('   npm run docker:up');
console.log('   - Frontend: http://localhost:8088');
console.log('   - Backend: http://localhost:8080');
console.log('   - API Docs: http://localhost:8080/api/docs');
console.log('');
