/**
 * Frontend configuration loaded from Vite environment variables
 * These are baked at build time
 */

export const config = {
  // API configuration
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:8080',
  
  // App metadata
  appName: import.meta.env.VITE_APP_NAME || 'Configer',
  appVersion: import.meta.env.VITE_APP_VERSION || '0.1.0',

  // Feature flags (will be overridden by /api/meta at runtime)
  features: {
    swagger_docs: true,
    offline_mode: true,
    ai_module: false,
    rbac: false,
    sso: false,
  },
};

/**
 * Load runtime configuration from the backend /api/meta endpoint
 */
export async function loadRuntimeConfig() {
  try {
    const response = await fetch(`${config.apiUrl}/api/meta`);
    if (!response.ok) throw new Error('Failed to load meta');
    
    const meta = await response.json();
    
    // Update feature flags from backend
    if (meta.features) {
      config.features = { ...config.features, ...meta.features };
    }
    
    // Update version if backend reports one
    if (meta.version) {
      config.appVersion = meta.version;
    }
    
    if (meta.name) {
      config.appName = meta.name;
    }
    
    return meta;
  } catch (error) {
    console.warn('Could not load runtime config from backend:', error);
    return null;
  }
}
