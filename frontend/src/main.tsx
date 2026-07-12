import React from 'react'
import ReactDOM from 'react-dom/client'
import { loadRuntimeConfig } from './config'
import './index.css'

// Placeholder App component
function App() {
  const [config, setConfig] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    loadRuntimeConfig().then(cfg => {
      setConfig(cfg)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [])

  if (loading) {
    return <div className="p-8 text-center">Loading configuration...</div>
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">Configer</h1>
      <p className="text-gray-600 mb-4">Enterprise-grade configuration management platform</p>
      
      {config && (
        <div className="bg-blue-50 border border-blue-200 rounded p-4">
          <h2 className="font-semibold mb-2">Backend Status</h2>
          <pre className="text-sm bg-white p-2 rounded overflow-auto">
            {JSON.stringify(config, null, 2)}
          </pre>
        </div>
      )}
      
      <div className="mt-8 text-sm text-gray-500">
        <p>✓ Frontend running on port 5173</p>
        <p>✓ Backend running on port 8080</p>
        <p>✓ <a href="http://localhost:8080/api/docs" className="text-blue-600 hover:underline" target="_blank">API Documentation (Swagger)</a></p>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
