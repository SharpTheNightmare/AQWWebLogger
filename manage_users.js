#!/usr/bin/env node
require('dotenv').config();
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV_FILE = path.join(__dirname, '.env');
const SALT_ROUNDS = 12;

// Parse .env file
function parseEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    return {};
  }
  
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const env = {};
  
  content.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key] = valueParts.join('=');
      }
    }
  });
  
  return env;
}

// Write .env file
function writeEnvFile(env) {
  const lines = [
    '# Authentication credentials (hashed passwords)',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    ''
  ];
  
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

// Get all users from .env
function getUsers() {
  const env = parseEnvFile();
  const users = {};
  
  // Find all username/password hash pairs
  Object.keys(env).forEach(key => {
    if (key.endsWith('_USERNAME')) {
      const prefix = key.replace('_USERNAME', '');
      const passwordKey = `${prefix}_PASSWORD_HASH`;
      
      if (env[passwordKey]) {
        users[env[key]] = {
          username: env[key],
          passwordHash: env[passwordKey],
          prefix: prefix
        };
      }
    }
  });
  
  return users;
}

// Hash password
async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

// Create readline interface for user input
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// Prompt for input
function prompt(question) {
  const rl = createInterface();
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Prompt for password (hidden input)
function promptPassword(question) {
  const rl = createInterface();
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
    // Hide password input
    rl.input.on('keypress', (char, key) => {
      if (key && (key.name === 'return' || key.name === 'enter')) {
        return;
      }
      // Clear the line and rewrite the prompt
      rl.output.write('\r' + question + '*'.repeat(rl.line.length));
    });
  });
}

// List all users
function listUsers() {
  const users = getUsers();
  const userList = Object.values(users);
  
  if (userList.length === 0) {
    console.log('No users found.');
    return;
  }
  
  console.log('\n=== Current Users ===');
  userList.forEach((user, index) => {
    console.log(`${index + 1}. ${user.username} (${user.prefix})`);
  });
  console.log('');
}

// Add user
async function addUser() {
  const username = await prompt('Enter username: ');
  
  if (!username) {
    console.log('Username cannot be empty.');
    return;
  }
  
  // Check if user already exists
  const users = getUsers();
  if (users[username]) {
    console.log(`User '${username}' already exists.`);
    return;
  }
  
  const password = await prompt('Enter password: ');
  
  if (!password) {
    console.log('Password cannot be empty.');
    return;
  }
  
  if (password.length < 6) {
    console.log('Password must be at least 6 characters long.');
    return;
  }
  
  console.log('Hashing password...');
  const passwordHash = await hashPassword(password);
  
  // Generate a unique prefix for this user
  const env = parseEnvFile();
  let prefix = username.toUpperCase();
  let counter = 1;
  
  // Ensure unique prefix
  while (env[`${prefix}_USERNAME`] && counter < 100) {
    prefix = `${username.toUpperCase()}${counter}`;
    counter++;
  }
  
  // Add to .env
  env[`${prefix}_USERNAME`] = username;
  env[`${prefix}_PASSWORD_HASH`] = passwordHash;
  
  writeEnvFile(env);
  
  console.log(`✅ User '${username}' added successfully!`);
  console.log(`Environment variables: ${prefix}_USERNAME, ${prefix}_PASSWORD_HASH`);
}

// Delete user
async function deleteUser() {
  const users = getUsers();
  const userList = Object.values(users);
  
  if (userList.length === 0) {
    console.log('No users to delete.');
    return;
  }
  
  listUsers();
  
  const input = await prompt('Enter username to delete (or number from list): ');
  
  let userToDelete;
  
  // Check if input is a number
  const index = parseInt(input) - 1;
  if (!isNaN(index) && index >= 0 && index < userList.length) {
    userToDelete = userList[index];
  } else {
    userToDelete = users[input];
  }
  
  if (!userToDelete) {
    console.log('User not found.');
    return;
  }
  
  const confirm = await prompt(`Are you sure you want to delete user '${userToDelete.username}'? (y/N): `);
  
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('Deletion cancelled.');
    return;
  }
  
  // Remove from .env
  const env = parseEnvFile();
  delete env[`${userToDelete.prefix}_USERNAME`];
  delete env[`${userToDelete.prefix}_PASSWORD_HASH`];
  
  writeEnvFile(env);
  
  console.log(`✅ User '${userToDelete.username}' deleted successfully!`);
}

// Change password
async function changePassword() {
  const users = getUsers();
  const userList = Object.values(users);
  
  if (userList.length === 0) {
    console.log('No users found.');
    return;
  }
  
  listUsers();
  
  const input = await prompt('Enter username to change password (or number from list): ');
  
  let userToUpdate;
  
  // Check if input is a number
  const index = parseInt(input) - 1;
  if (!isNaN(index) && index >= 0 && index < userList.length) {
    userToUpdate = userList[index];
  } else {
    userToUpdate = users[input];
  }
  
  if (!userToUpdate) {
    console.log('User not found.');
    return;
  }
  
  const newPassword = await prompt(`Enter new password for '${userToUpdate.username}': `);
  
  if (!newPassword) {
    console.log('Password cannot be empty.');
    return;
  }
  
  if (newPassword.length < 6) {
    console.log('Password must be at least 6 characters long.');
    return;
  }
  
  console.log('Hashing password...');
  const passwordHash = await hashPassword(newPassword);
  
  // Update .env
  const env = parseEnvFile();
  env[`${userToUpdate.prefix}_PASSWORD_HASH`] = passwordHash;
  
  writeEnvFile(env);
  
  console.log(`✅ Password for user '${userToUpdate.username}' updated successfully!`);
}

// Main menu
async function showMenu() {
  console.log('\n=== User Management for Veinheim Bot Logger ===');
  console.log('1. List users');
  console.log('2. Add user');
  console.log('3. Delete user');
  console.log('4. Change password');
  console.log('5. Exit');
  
  const choice = await prompt('\nSelect an option (1-5): ');
  
  switch (choice) {
    case '1':
      listUsers();
      break;
    case '2':
      await addUser();
      break;
    case '3':
      await deleteUser();
      break;
    case '4':
      await changePassword();
      break;
    case '5':
      console.log('Goodbye!');
      process.exit(0);
    default:
      console.log('Invalid option. Please select 1-5.');
  }
  
  // Show menu again unless exiting
  if (choice !== '5') {
    await showMenu();
  }
}

// Handle command line arguments
async function handleCLI() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Interactive mode
    await showMenu();
    return;
  }
  
  const command = args[0];
  
  switch (command) {
    case 'list':
      listUsers();
      break;
    case 'add':
      if (args.length < 3) {
        console.log('Usage: node manage_users.js add <username> <password>');
        process.exit(1);
      }
      const [, username, password] = args;
      await addUserDirect(username, password);
      break;
    case 'delete':
      if (args.length < 2) {
        console.log('Usage: node manage_users.js delete <username>');
        process.exit(1);
      }
      await deleteUserDirect(args[1]);
      break;
    case 'change':
      if (args.length < 3) {
        console.log('Usage: node manage_users.js change <username> <new_password>');
        process.exit(1);
      }
      await changePasswordDirect(args[1], args[2]);
      break;
    default:
      console.log('Usage: node manage_users.js [command] [args]');
      console.log('Commands:');
      console.log('  list                          - List all users');
      console.log('  add <username> <password>     - Add a new user');
      console.log('  delete <username>             - Delete a user');
      console.log('  change <username> <password>  - Change user password');
      console.log('  (no args)                     - Interactive mode');
      process.exit(1);
  }
}

// Direct functions for CLI usage
async function addUserDirect(username, password) {
  const users = getUsers();
  
  if (users[username]) {
    console.log(`❌ User '${username}' already exists.`);
    process.exit(1);
  }
  
  if (password.length < 6) {
    console.log('❌ Password must be at least 6 characters long.');
    process.exit(1);
  }
  
  const passwordHash = await hashPassword(password);
  const env = parseEnvFile();
  
  let prefix = username.toUpperCase();
  let counter = 1;
  
  while (env[`${prefix}_USERNAME`] && counter < 100) {
    prefix = `${username.toUpperCase()}${counter}`;
    counter++;
  }
  
  env[`${prefix}_USERNAME`] = username;
  env[`${prefix}_PASSWORD_HASH`] = passwordHash;
  
  writeEnvFile(env);
  console.log(`✅ User '${username}' added successfully!`);
}

async function deleteUserDirect(username) {
  const users = getUsers();
  const user = users[username];
  
  if (!user) {
    console.log(`❌ User '${username}' not found.`);
    process.exit(1);
  }
  
  const env = parseEnvFile();
  delete env[`${user.prefix}_USERNAME`];
  delete env[`${user.prefix}_PASSWORD_HASH`];
  
  writeEnvFile(env);
  console.log(`✅ User '${username}' deleted successfully!`);
}

async function changePasswordDirect(username, newPassword) {
  const users = getUsers();
  const user = users[username];
  
  if (!user) {
    console.log(`❌ User '${username}' not found.`);
    process.exit(1);
  }
  
  if (newPassword.length < 6) {
    console.log('❌ Password must be at least 6 characters long.');
    process.exit(1);
  }
  
  const passwordHash = await hashPassword(newPassword);
  const env = parseEnvFile();
  env[`${user.prefix}_PASSWORD_HASH`] = passwordHash;
  
  writeEnvFile(env);
  console.log(`✅ Password for user '${username}' updated successfully!`);
}

// Start the application
handleCLI().catch(console.error);
