/**
 * Utility functions for API requests with authentication
 */

interface RequestOptions extends RequestInit {
  // Additional options can be added here
}

/**
 * Helper function to get token from localStorage
 */
export const getToken = (): string | null => {
  return localStorage.getItem('cc-pet-token');
};

/**
 * Helper function to make authenticated fetch requests
 */
export const authenticatedFetch = async (url: string, options: RequestOptions = {}): Promise<Response> => {
  const token = getToken();
  if (!token) {
    throw new Error('No authentication token found');
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    ...(options.headers as Record<string, string>),
  };

  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  return fetch(url, {
    ...options,
    headers,
  });
};

/**
 * Generic API request wrapper with error handling
 */
export const apiRequest = async <T>(url: string, options: RequestOptions = {}): Promise<T> => {
  const response = await authenticatedFetch(url, options);

  if (!response.ok) {
    const errorMessage = `API request failed with status ${response.status}: ${response.statusText}`;
    throw new Error(errorMessage);
  }

  // Handle potential empty response
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  } else {
    // Return empty object if no JSON response
    return {} as T;
  }
};