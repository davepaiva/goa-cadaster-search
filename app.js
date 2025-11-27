import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";

class CadastralDataApp {
    constructor() {
        this.db = null;
        this.loadedFiles = new Set(); // Track loaded files
        this.currentData = null; // Store current query results
        this.currentFilters = {}; // Store current filters
        this.viewMode = 'summary'; // 'summary' or 'detailed'
        this.map = null; // Google Maps instance
        this.mapFeatures = []; // Store current map features
        this.mapPolygons = []; // Store Google Maps polygon objects
        this.mapInfoWindows = []; // Store info windows
        this.init();
    }

    async init() {
        try {
            console.log('Initializing DuckDB...');
            
            // Show loading indicators
            $('#loading').show();
            $('#taluka-dropdown').empty().append('<option value="">Loading talukas...</option>').prop('disabled', true);
            
            // Initialize DuckDB using the correct method names
            const bundles = duckdb.getJsDelivrBundles();
            const bundle = await duckdb.selectBundle(bundles);
            const worker = await duckdb.createWorker(bundle.mainWorker);
            const logger = new duckdb.ConsoleLogger();
            this.db = new duckdb.AsyncDuckDB(logger, worker);
            await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
            
            console.log('DuckDB initialized successfully');

            // Try to load spatial extension at startup
            try {
                const connection = await this.db.connect();
                try {
                    await connection.query("INSTALL spatial;");
                    await connection.query("LOAD spatial;");
                    console.log('Spatial extension loaded at startup');
                    this.spatialEnabled = true;
                } catch (spatialError) {
                    console.warn('Spatial extension not available:', spatialError.message);
                    this.spatialEnabled = false;
                } finally {
                    await connection.close();
                }
            } catch (error) {
                console.warn('Could not test spatial extension:', error.message);
                this.spatialEnabled = false;
            }

            // Initialize map
            this.initializeMap();

            // Load initial dropdown data
            await this.loadDropdownData();
            this.setupEventListeners();
            
            // Hide main loading indicator
            $('#loading').hide();
        } catch (error) {
            console.error('Failed to initialize DuckDB:', error);
            console.error('Error details:', error);
            $('#taluka-dropdown').empty().append('<option value="">Failed to initialize database</option>').prop('disabled', false);
            $('#loading').hide();
        }
    }

    initializeMap() {
        try {
            // Initialize Google Maps centered on Goa with satellite view
            this.map = new google.maps.Map(document.getElementById('map'), {
                center: { lat: 15.2993, lng: 74.124 }, // Goa coordinates
                zoom: 10,
                mapTypeId: 'satellite', // Set to satellite view
                mapTypeControl: true,
                mapTypeControlOptions: {
                    style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
                    position: google.maps.ControlPosition.TOP_RIGHT
                },
                zoomControl: true,
                streetViewControl: false,
                fullscreenControl: true
            });

            console.log('Google Maps initialized successfully');

        } catch (error) {
            console.error('Failed to initialize map:', error);
        }
    }

    async loadDropdownData() {
        try {
            console.log('Starting to load dropdown data...');
            // Load taluka and mapping files (small files, loaded once)
            await this.loadParquetFile('talukas.parquet', 'talukas');
            await this.loadParquetFile('taluka_village_mapping.parquet', 'mapping');
            
            // Populate taluka dropdown
            await this.populateTalukaDropdown();
            console.log('Finished loading dropdown data');
        } catch (error) {
            console.error('Error loading dropdown data:', error);
            // Show error to user
            $('#taluka-dropdown').append('<option value="">Error loading data</option>');
        }
    }

    async loadParquetFile(filename, tableName) {
        if (this.loadedFiles.has(tableName)) {
            console.log(`${tableName} already loaded, skipping`);
            return; // Already loaded
        }

        console.log(`Loading ${filename} as table ${tableName}...`);
        const connection = await this.db.connect();
        
        try {
            // Try multiple URL strategies for GitHub Pages compatibility
            const urlStrategies = [
                // Strategy 1: Current approach
                () => {
                    const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '');
                    return `${baseUrl}/data/${filename}`;
                },
                // Strategy 2: Direct relative path (for GitHub Pages root deployment)
                () => `./data/${filename}`,
                // Strategy 3: Absolute path from root
                () => `${window.location.origin}${window.location.pathname.split('/').slice(0, -1).join('/')}/data/${filename}`,
                // Strategy 4: Using repo name if available
                () => {
                    const pathParts = window.location.pathname.split('/').filter(p => p);
                    if (pathParts.length > 0) {
                        return `${window.location.origin}/${pathParts[0]}/data/${filename}`;
                    }
                    return null;
                }
            ];

            let lastError = null;
            
            for (let i = 0; i < urlStrategies.length; i++) {
                const fileUrl = urlStrategies[i]();
                if (!fileUrl) continue;
                
                console.log(`Trying strategy ${i + 1}: ${fileUrl}`);
                
                try {
                    // First, let's verify the URL is accessible
                    const response = await fetch(fileUrl, { method: 'HEAD' });
                    console.log(`File check for ${filename}: Status ${response.status}, Content-Length: ${response.headers.get('content-length')}, Content-Type: ${response.headers.get('content-type')}`);
                    
                    if (!response.ok) {
                        throw new Error(`File not accessible: HTTP ${response.status} ${response.statusText}`);
                    }
                    
                    const contentLength = response.headers.get('content-length');
                    if (contentLength === '0' || contentLength === null) {
                        console.warn(`Warning: File ${filename} appears to be empty or content-length not set`);
                    }
                    
                    // Try to load with DuckDB
                    await connection.query(`
                        CREATE TABLE ${tableName} AS 
                        SELECT * FROM read_parquet('${fileUrl}')
                    `);
                    
                    this.loadedFiles.add(tableName);
                    console.log(`Successfully loaded ${tableName} table using strategy ${i + 1}`);
                    return; // Success!
                    
                } catch (strategyError) {
                    console.warn(`Strategy ${i + 1} failed for ${filename}:`, strategyError.message);
                    lastError = strategyError;
                    continue; // Try next strategy
                }
            }
            
            // If we get here, all strategies failed
            throw lastError || new Error('All loading strategies failed');
            
        } catch (error) {
            console.error(`Error loading ${filename}:`, error);
            
            // Enhanced error reporting
            if (error.message.includes('magic bytes')) {
                console.error('Magic bytes error suggests file corruption, wrong content-type, or incomplete download');
                console.error('This commonly happens when GitHub Pages serves binary files incorrectly');
                console.error('Possible solutions:');
                console.error('1. Check if file is properly committed to git');
                console.error('2. Ensure .gitattributes marks *.parquet as binary');
                console.error('3. Consider using Git LFS for large files');
                console.error('4. Try re-committing the parquet files');
                console.error('5. Check GitHub Pages deployment logs');
            }
            
            // Provide user-friendly error message
            const userError = new Error(
                error.message.includes('magic bytes') 
                    ? `Unable to load ${filename}. This appears to be a GitHub Pages deployment issue with binary files. Please check the browser console for detailed troubleshooting steps.`
                    : `Failed to load ${filename}: ${error.message}`
            );
            throw userError;
        } finally {
            await connection.close();
        }
    }

    async populateTalukaDropdown() {
        console.log('Populating taluka dropdown...');
        const connection = await this.db.connect();
        
        try {
            // First, let's check what's in the talukas table
            const checkResult = await connection.query(`
                SELECT COUNT(*) as count FROM talukas
            `);
            console.log('Talukas table count:', checkResult.toArray());

            // Check the structure of the table
            const structureResult = await connection.query(`
                DESCRIBE talukas
            `);
            console.log('Talukas table structure:', structureResult.toArray());

            const result = await connection.query(`
                SELECT taluka, village_count 
                FROM talukas 
                ORDER BY taluka
            `);
            
            const data = result.toArray();
            console.log('Taluka data retrieved:', data);
            
            const dropdown = $('#taluka-dropdown');
            dropdown.empty().append('<option value="">Select Taluka</option>');
            
            if (data.length === 0) {
                console.warn('No taluka data found');
                dropdown.append('<option value="">No data available</option>')
                       .prop('disabled', false);
                return;
            }
            
            data.forEach(row => {
                dropdown.append(`
                    <option value="${row.taluka}">
                        ${row.taluka} (${row.village_count} villages)
                    </option>
                `);
            });
            
            // Enable the dropdown once data is loaded
            dropdown.prop('disabled', false);
            
            console.log(`Successfully populated ${data.length} talukas in dropdown`);
        } catch (error) {
            console.error('Error in populateTalukaDropdown:', error);
            const dropdown = $('#taluka-dropdown');
            dropdown.empty().append('<option value="">Error loading talukas</option>')
                   .prop('disabled', false);
            throw error;
        } finally {
            await connection.close();
        }
    }

    async populateVillageDropdown(selectedTaluka) {
        console.log('Populating village dropdown for taluka:', selectedTaluka);
        
        // Check if mapping table exists
        const connection = await this.db.connect();
        
        try {
            // First check if the mapping table exists
            try {
                // Use string interpolation instead of parameterized query for now
                const escapedTaluka = selectedTaluka.replace(/'/g, "''"); // Escape single quotes
                const checkResult = await connection.query(`
                    SELECT COUNT(*) as count FROM mapping WHERE taluka = '${escapedTaluka}'
                `);
                console.log('Villages found for taluka:', checkResult.toArray());
            } catch (tableError) {
                console.error('Mapping table might not exist:', tableError);
                // Try to reload the mapping file
                console.log('Attempting to reload mapping file...');
                await this.loadParquetFile('taluka_village_mapping.parquet', 'mapping');
            }
            
            // Use string interpolation for the main query too
            const escapedTaluka = selectedTaluka.replace(/'/g, "''"); // Escape single quotes
            const result = await connection.query(`
                SELECT village 
                FROM mapping 
                WHERE taluka = '${escapedTaluka}' 
                ORDER BY village
            `);
            
            const villages = result.toArray();
            console.log('Villages retrieved:', villages);
            
            const dropdown = $('#village-dropdown');
            dropdown.empty().append('<option value="">Select Village</option>');
            
            if (villages.length === 0) {
                dropdown.append('<option value="">No villages found</option>');
            } else {
                villages.forEach(row => {
                    dropdown.append(`<option value="${row.village}">${row.village}</option>`);
                });
            }
            
            dropdown.prop('disabled', false);
            
            // Reset and disable subsequent dropdowns
            $('#survey-dropdown').prop('disabled', true).empty()
                .append('<option value="">Select Survey No (Optional)</option>');
            $('#subdiv-dropdown').prop('disabled', true).empty()
                .append('<option value="">Select Subdiv (Optional)</option>');
        } finally {
            await connection.close();
        }
    }

    async populateSurveyDropdown(villageName) {
        console.log('Populating survey dropdown for village:', villageName);
        
        try {
            // Load village parquet file if not already loaded
            const safeVillageName = villageName.replace(/[^a-zA-Z0-9-_]/g, '_');
            const tableName = `village_${safeVillageName}`;
            
            if (!this.loadedFiles.has(tableName)) {
                await this.loadParquetFile(`${villageName}.parquet`, tableName);
            }

            const connection = await this.db.connect();
            
            try {
                const result = await connection.query(`
                    SELECT DISTINCT survey
                    FROM ${tableName}
                    WHERE survey IS NOT NULL
                    ORDER BY survey
                `);
                
                const surveys = result.toArray();
                console.log('Surveys retrieved:', surveys);
                
                const dropdown = $('#survey-dropdown');
                dropdown.empty().append('<option value="">Select Survey No (Optional)</option>');
                
                if (surveys.length === 0) {
                    dropdown.append('<option value="">No surveys found</option>');
                } else {
                    surveys.forEach(row => {
                        dropdown.append(`<option value="${row.survey}">${row.survey}</option>`);
                    });
                }
                
                dropdown.prop('disabled', false);
                
                // Reset subdiv dropdown
                $('#subdiv-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Subdiv (Optional)</option>');
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating survey dropdown:', error);
            $('#survey-dropdown').empty().append('<option value="">Error loading surveys</option>');
        }
    }

    async populateSubdivDropdown(villageName, surveyNo) {
        console.log('Populating subdiv dropdown for village:', villageName, 'survey:', surveyNo);
        
        try {
            const safeVillageName = villageName.replace(/[^a-zA-Z0-9-_]/g, '_');
            const tableName = `village_${safeVillageName}`;
            
            const connection = await this.db.connect();
            
            try {
                let query;
                if (surveyNo) {
                    // Filter by survey number
                    const escapedSurvey = surveyNo.replace(/'/g, "''");
                    query = `
                        SELECT DISTINCT subdiv
                        FROM ${tableName}
                        WHERE survey = '${escapedSurvey}' AND subdiv IS NOT NULL
                        ORDER BY subdiv
                    `;
                } else {
                    // Show all subdivs for the village
                    query = `
                        SELECT DISTINCT subdiv
                        FROM ${tableName}
                        WHERE subdiv IS NOT NULL
                        ORDER BY subdiv
                    `;
                }
                
                const result = await connection.query(query);
                const subdivs = result.toArray();
                console.log('Subdivs retrieved:', subdivs);
                
                const dropdown = $('#subdiv-dropdown');
                dropdown.empty().append('<option value="">Select Subdiv (Optional)</option>');
                
                if (subdivs.length === 0) {
                    dropdown.append('<option value="">No subdivs found</option>');
                } else {
                    subdivs.forEach(row => {
                        dropdown.append(`<option value="${row.subdiv}">${row.subdiv}</option>`);
                    });
                }
                
                dropdown.prop('disabled', false);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating subdiv dropdown:', error);
            $('#subdiv-dropdown').empty().append('<option value="">Error loading subdivs</option>');
        }
    }

    async loadVillageData(villageName, surveyNo = null, subdivNo = null) {
        $('#loading').show();
        $('#results').empty();

        try {
            // Load village parquet file on-demand
            const safeVillageName = villageName.replace(/[^a-zA-Z0-9-_]/g, '_');
            const tableName = `village_${safeVillageName}`;
            
            if (!this.loadedFiles.has(tableName)) {
                await this.loadParquetFile(`${villageName}.parquet`, tableName);
            }

            // Query the village data with optional filters
            const connection = await this.db.connect();
            
            try {
                let whereClause = '';
                let filters = [];
                
                if (surveyNo) {
                    const escapedSurvey = surveyNo.replace(/'/g, "''");
                    filters.push(`survey = '${escapedSurvey}'`);
                }
                
                if (subdivNo) {
                    const escapedSubdiv = subdivNo.replace(/'/g, "''");
                    filters.push(`subdiv = '${escapedSubdiv}'`);
                }
                
                if (filters.length > 0) {
                    whereClause = 'WHERE ' + filters.join(' AND ');
                }
                
                // Use spatial functions if available, otherwise show info message
                let result;
                if (this.spatialEnabled) {
                    try {
                        result = await connection.query(`
                            SELECT taluka, village, survey, subdiv, 
                                   ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson,
                                   COUNT(*) as record_count
                            FROM ${tableName}
                            ${whereClause}
                            GROUP BY taluka, village, survey, subdiv, geometry
                            ORDER BY survey, subdiv
                            LIMIT 100
                        `);
                        console.log('Successfully used ST_AsGeoJSON with WKB conversion');
                    } catch (spatialError) {
                        console.warn('ST_AsGeoJSON failed despite spatial being enabled:', spatialError.message);
                        this.spatialEnabled = false; // Disable for future queries
                        // Fallback to info message without using geometry column
                        result = await connection.query(`
                            SELECT taluka, village, survey, subdiv, 
                                   'WKB Binary Geometry Data (Spatial functions failed)' as geometry_geojson,
                                   COUNT(*) as record_count
                            FROM ${tableName}
                            ${whereClause}
                            GROUP BY taluka, village, survey, subdiv
                            ORDER BY survey, subdiv
                            LIMIT 100
                        `);
                    }
                } else {
                    // Spatial not available, show info message without using geometry column
                    result = await connection.query(`
                        SELECT taluka, village, survey, subdiv, 
                               'WKB Binary Geometry Data (Spatial extension not available in DuckDB WASM)' as geometry_geojson,
                               COUNT(*) as record_count
                        FROM ${tableName}
                        ${whereClause}
                        GROUP BY taluka, village, survey, subdiv
                        ORDER BY survey, subdiv
                        LIMIT 100
                    `);
                }
                
                this.displayResults(result.toArray(), surveyNo, subdivNo);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error loading village data:', error);
            $('#results').html(`<p>Error loading data: ${error.message}</p>`);
        } finally {
            $('#loading').hide();
        }
    }

    displayResults(data, surveyFilter = null, subdivFilter = null) {
        if (data.length === 0) {
            $('#results').html('<p>No data found for the selected criteria</p>');
            $('#map-container').hide();
            return;
        }

        let filterText = '';
        if (surveyFilter) filterText += ` (Survey: ${surveyFilter})`;
        if (subdivFilter) filterText += ` (Subdiv: ${subdivFilter})`;

        let html = `
            <h3>Cadastral Data${filterText} (${data.length} records)</h3>
            <p style="font-size: 12px; color: #666; margin-bottom: 10px;">💡 Click on any row to zoom to that parcel on the map</p>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Taluka</th>
                            <th>Village</th>
                            <th>Survey</th>
                            <th>Subdiv</th>
                            <th>Records</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        // Initialize geometry data storage if not exists
        if (!window.geometryData) {
            window.geometryData = {};
        }
        // Track geometry IDs for current table (for bulk download)
        window.currentGeometryIds = [];

        // Collect valid GeoJSON features for the map
        const mapFeatures = [];
        let hasGeometry = false;

        data.forEach((row, index) => {
            let geometryDisplay = '';
            let hasValidGeometry = false;
            let geometryForZoom = null;
            
            if (row.geometry_geojson) {
                const geometryId = `geometry-${index}`;
                
                // Ensure we have a string to work with
                let geometryString = '';
                let geojsonGeometry = null;
                
                try {
                    if (typeof row.geometry_geojson === 'string') {
                        geometryString = row.geometry_geojson;
                    } else if (typeof row.geometry_geojson === 'object') {
                        geometryString = JSON.stringify(row.geometry_geojson);
                    } else {
                        geometryString = String(row.geometry_geojson);
                    }
                    
                    // Try to parse and add to map if it's valid GeoJSON
                    if (geometryString && !geometryString.includes('WKB Binary')) {
                        try {
                            geojsonGeometry = JSON.parse(geometryString);
                            if (geojsonGeometry && geojsonGeometry.type) {
                                // Convert any BigInt values to regular numbers
                                const safeProperties = {
                                    taluka: String(row.taluka || ''),
                                    village: String(row.village || ''),
                                    survey: String(row.survey || ''),
                                    subdiv: String(row.subdiv || ''),
                                    records: typeof row.record_count === 'bigint' ? Number(row.record_count) : row.record_count
                                };
                                
                                mapFeatures.push({
                                    type: 'Feature',
                                    geometry: geojsonGeometry,
                                    properties: safeProperties
                                });
                                hasGeometry = true;
                                hasValidGeometry = true;
                                geometryForZoom = geojsonGeometry;
                                
                                // Store geometry data for button/download access
                                const filenameParts = [
                                    safeProperties.village || 'village',
                                    safeProperties.survey || 'survey',
                                    safeProperties.subdiv || 'subdiv'
                                ];
                                const baseName = filenameParts.join('_').replace(/[^a-zA-Z0-9_-]+/g, '_');
                                // Ensure uniqueness even when survey + subdiv repeat
                                const filename = `${baseName}_(${index + 1})`;
                                
                                window.geometryData[geometryId] = {
                                    geojson: JSON.stringify(geojsonGeometry, null, 2),
                                    geometry: geojsonGeometry,
                                    filename
                                };
                                // Track this geometry for master download
                                window.currentGeometryIds.push(geometryId);
                            }
                        } catch (parseError) {
                            console.warn('Could not parse geometry as GeoJSON:', parseError);
                        }
                    }
                } catch (e) {
                    console.error('Error converting geometry to string:', e);
                }
                
                if (hasValidGeometry) {
                    geometryDisplay = `
                        <div style="display: flex; gap: 8px;">
                            <button onclick="copyKML('${geometryId}')" 
                                    style="padding: 6px 12px; font-size: 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                Download KML
                            </button>
                            <button onclick="copyGeoJSON('${geometryId}')" 
                                    style="padding: 6px 12px; font-size: 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                Copy GeoJSON
                            </button>
                        </div>
                    `;
                } else {
                    geometryDisplay = '<em>No geometry data</em>';
                }
            } else {
                geometryDisplay = '<em>No geometry data</em>';
            }

            // Create row with click handler for zoom functionality
            const rowClass = hasValidGeometry ? 'clickable-row' : '';
            const rowStyle = hasValidGeometry ? 'cursor: pointer; transition: background-color 0.2s;' : '';
            const onClickHandler = hasValidGeometry ? `onclick="window.cadastralApp.zoomToGeometry(${JSON.stringify(geometryForZoom).replace(/"/g, '&quot;')})"` : '';

            html += `
                <tr class="${rowClass}" style="${rowStyle}" ${onClickHandler} 
                    onmouseover="if(this.classList.contains('clickable-row')) this.style.backgroundColor='#f8f9fa'" 
                    onmouseout="if(this.classList.contains('clickable-row')) this.style.backgroundColor=''">
                    <td>${row.taluka}</td>
                    <td>${row.village}</td>
                    <td>${row.survey}</td>
                    <td>${row.subdiv}</td>
                    <td>${row.record_count}</td>
                    <td style="max-width: 350px;" onclick="event.stopPropagation()">${geometryDisplay}</td>
                </tr>
            `;
        });

        html += '</tbody></table></div>';
        
        $('#results').html(html);

        // Show/hide master download button based on geometry availability
        if (window.currentGeometryIds && window.currentGeometryIds.length > 0) {
            $('#download-all-container').show();
        } else {
            $('#download-all-container').hide();
        }

        // Update map with new data
        this.updateMap(mapFeatures, hasGeometry);
    }

    updateMap(features, hasGeometry) {
        if (!this.map) {
            console.warn('Map not ready yet');
            return;
        }

        try {
            // Clear existing polygons
            this.clearMapPolygons();

            // Store features for other operations
            this.mapFeatures = features;

            // Show/hide map based on whether we have geometry data
            if (hasGeometry && features.length > 0) {
                $('#map-container').show();
                
                // Update map info
                $('#map-info').text(`Showing ${features.length} cadastral parcels`);
                
                // Add polygons to map
                features.forEach((feature, index) => {
                    this.addPolygonToMap(feature, index);
                });
                
                // Fit map to show all features
                setTimeout(() => {
                    this.fitMapToBounds();
                }, 100);
            } else {
                $('#map-container').hide();
            }
        } catch (error) {
            console.error('Error updating map:', error);
        }
    }

    clearMapPolygons() {
        // Remove all existing polygons from the map
        this.mapPolygons.forEach(polygon => {
            polygon.setMap(null);
        });
        this.mapPolygons = [];

        // Close all info windows
        this.mapInfoWindows.forEach(infoWindow => {
            infoWindow.close();
        });
        this.mapInfoWindows = [];
    }

    addPolygonToMap(feature, index) {
        if (!feature.geometry || !this.map) return;

        try {
            const geometry = feature.geometry;
            let paths = [];

            if (geometry.type === 'Polygon') {
                // Convert GeoJSON coordinates to Google Maps LatLng format
                paths = geometry.coordinates[0].map(coord => ({
                    lat: coord[1],
                    lng: coord[0]
                }));
            } else if (geometry.type === 'MultiPolygon') {
                // For MultiPolygon, use the first polygon
                paths = geometry.coordinates[0][0].map(coord => ({
                    lat: coord[1],
                    lng: coord[0]
                }));
            } else {
                console.warn('Unsupported geometry type:', geometry.type);
                return;
            }

            // Create polygon with styling
            const polygon = new google.maps.Polygon({
                paths: paths,
                strokeColor: '#007cba',
                strokeOpacity: 1.0,
                strokeWeight: 2,
                fillColor: '#007cba',
                fillOpacity: 0.3,
                map: this.map
            });

            // Create info window content
            const infoContent = `
                <div style="font-size: 12px;">
                    <strong>Cadastral Information</strong><br>
                    <strong>Taluka:</strong> ${feature.properties.taluka || 'N/A'}<br>
                    <strong>Village:</strong> ${feature.properties.village || 'N/A'}<br>
                    <strong>Survey:</strong> ${feature.properties.survey || 'N/A'}<br>
                    <strong>Subdiv:</strong> ${feature.properties.subdiv || 'N/A'}
                </div>
            `;

            const infoWindow = new google.maps.InfoWindow({
                content: infoContent
            });

            // Add click listener to polygon
            polygon.addListener('click', (event) => {
                // Close all other info windows
                this.mapInfoWindows.forEach(iw => iw.close());
                
                infoWindow.setPosition(event.latLng);
                infoWindow.open(this.map);
            });

            // Store polygon and info window
            this.mapPolygons.push(polygon);
            this.mapInfoWindows.push(infoWindow);

        } catch (error) {
            console.error('Error adding polygon to map:', error);
        }
    }

    fitMapToBounds() {
        if (!this.mapFeatures || this.mapFeatures.length === 0 || !this.map) return;

        try {
            const bounds = new google.maps.LatLngBounds();
            
            this.mapFeatures.forEach(feature => {
                if (feature.geometry.type === 'Polygon') {
                    feature.geometry.coordinates[0].forEach(coord => {
                        bounds.extend({ lat: coord[1], lng: coord[0] });
                    });
                } else if (feature.geometry.type === 'MultiPolygon') {
                    feature.geometry.coordinates.forEach(polygon => {
                        polygon[0].forEach(coord => {
                            bounds.extend({ lat: coord[1], lng: coord[0] });
                        });
                    });
                } else if (feature.geometry.type === 'Point') {
                    bounds.extend({ lat: feature.geometry.coordinates[1], lng: feature.geometry.coordinates[0] });
                }
            });

            this.map.fitBounds(bounds, { padding: 50 });
        } catch (error) {
            console.error('Error fitting bounds:', error);
        }
    }

    setupEventListeners() {
        // CSV upload event listeners
        $('#csv-upload').on('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                $('#process-csv').prop('disabled', false);
                $('#csv-status').text(`Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
            } else {
                $('#process-csv').prop('disabled', true);
                $('#csv-status').text('');
            }
        });

        $('#process-csv').on('click', () => {
            this.processCsvFile();
        });

        $('#download-template').on('click', () => {
            this.downloadCsvTemplate();
        });

        // Existing event listeners
        $('#taluka-dropdown').on('change', async (e) => {
            const selectedTaluka = e.target.value;
            console.log('Taluka selected:', selectedTaluka);
            console.log('Loaded files:', Array.from(this.loadedFiles));
            
            if (selectedTaluka) {
                try {
                    await this.populateVillageDropdown(selectedTaluka);
                } catch (error) {
                    console.error('Error in taluka selection:', error);
                    alert('Error loading village data: ' + error.message);
                }
            } else {
                $('#village-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Village</option>');
                $('#survey-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Survey No (Optional)</option>');
                $('#subdiv-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Subdiv (Optional)</option>');
            }
        });

        $('#village-dropdown').on('change', async (e) => {
            const selectedVillage = e.target.value;
            console.log('Village selected:', selectedVillage);
            
            if (selectedVillage) {
                try {
                    await this.populateSurveyDropdown(selectedVillage);
                } catch (error) {
                    console.error('Error in village selection:', error);
                    alert('Error loading survey data: ' + error.message);
                }
            } else {
                $('#survey-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Survey No (Optional)</option>');
                $('#subdiv-dropdown').prop('disabled', true).empty()
                    .append('<option value="">Select Subdiv (Optional)</option>');
            }
        });

        $('#survey-dropdown').on('change', async (e) => {
            const selectedSurvey = e.target.value;
            const selectedVillage = $('#village-dropdown').val();
            console.log('Survey selected:', selectedSurvey);
            
            if (selectedVillage) {
                try {
                    await this.populateSubdivDropdown(selectedVillage, selectedSurvey);
                } catch (error) {
                    console.error('Error in survey selection:', error);
                    alert('Error loading subdiv data: ' + error.message);
                }
            }
        });

        $('#load-data').on('click', async () => {
            const selectedVillage = $('#village-dropdown').val();
            const selectedSurvey = $('#survey-dropdown').val();
            const selectedSubdiv = $('#subdiv-dropdown').val();
            
            if (selectedVillage) {
                await this.loadVillageData(selectedVillage, selectedSurvey, selectedSubdiv);
            } else {
                alert('Please select a village first');
            }
        });

        // Map control event listeners
        $('#fit-bounds').on('click', () => {
            this.fitMapToBounds();
        });

        $('#toggle-labels').on('click', () => {
            // Labels functionality not applicable for Google Maps polygons
            // Could be implemented with markers if needed
            console.log('Label toggle not implemented for Google Maps');
        });

        $('#clear-map').on('click', () => {
            if (this.map) {
                this.clearMapPolygons();
                this.mapFeatures = [];
                $('#map-info').text('Map cleared');
                $('#map-container').hide();
            }
        });
    }

    downloadCsvTemplate() {
        const csvContent = `taluka,village,survey,subdiv
Tiswadi,Panaji,123,A
Salcete,Margao,456,B
Mormugao,Vasco,789,C`;
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cadastral_search_template.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        $('#csv-status').html('<span style="color: #28a745;">✓ Template downloaded</span>');
    }

    async processCsvFile() {
        const fileInput = document.getElementById('csv-upload');
        const file = fileInput.files[0];
        
        if (!file) {
            alert('Please select a CSV file first');
            return;
        }

        $('#csv-status').text('Processing CSV...');
        $('#process-csv').prop('disabled', true);

        try {
            const csvText = await this.readFileAsText(file);
            const searchCriteria = this.parseCsv(csvText);
            
            if (searchCriteria.length === 0) {
                $('#csv-status').html('<span style="color: #dc3545;">No valid data found in CSV</span>');
                $('#process-csv').prop('disabled', false);
                return;
            }

            $('#csv-status').text(`Found ${searchCriteria.length} search criteria. Searching...`);
            
            await this.performBulkSearch(searchCriteria);
            
        } catch (error) {
            console.error('Error processing CSV:', error);
            $('#csv-status').html(`<span style="color: #dc3545;">Error: ${error.message}</span>`);
        } finally {
            $('#process-csv').prop('disabled', false);
        }
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    parseCsv(csvText) {
        const lines = csvText.trim().split('\n');
        if (lines.length < 2) {
            throw new Error('CSV must have at least a header row and one data row');
        }

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const talukaIndex = headers.indexOf('taluka');
        const villageIndex = headers.indexOf('village');
        const surveyIndex = headers.indexOf('survey');
        const subdivIndex = headers.indexOf('subdiv');

        if (villageIndex === -1) {
            throw new Error('CSV must have a "village" column');
        }

        if (talukaIndex === -1) {
            throw new Error('CSV must have a "taluka" column');
        }

        const searchCriteria = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            
            if (values.length >= headers.length && values[villageIndex] && values[talukaIndex]) {
                searchCriteria.push({
                    taluka: values[talukaIndex],
                    village: values[villageIndex],
                    survey: surveyIndex !== -1 ? values[surveyIndex] : null,
                    subdiv: subdivIndex !== -1 ? values[subdivIndex] : null
                });
            }
        }

        return searchCriteria;
    }

    async performBulkSearch(searchCriteria) {
        $('#loading').show();
        $('#results').empty();

        try {
            const allResults = [];
            const allMapFeatures = [];
            let hasGeometry = false;
            
            for (const criteria of searchCriteria) {
                try {
                    const results = await this.searchSingleCriteria(criteria);
                    allResults.push(...results.data);
                    allMapFeatures.push(...results.mapFeatures);
                    if (results.hasGeometry) hasGeometry = true;
                } catch (error) {
                    console.warn(`Error searching for ${criteria.taluka}/${criteria.village}/${criteria.survey}/${criteria.subdiv}:`, error);
                }
            }

            if (allResults.length === 0) {
                $('#csv-status').html('<span style="color: #dc3545;">No matching records found</span>');
                $('#results').html('<p>No data found for any of the search criteria</p>');
                $('#map-container').hide();
                return;
            }

            $('#csv-status').html(`<span style="color: #28a745;">✓ Found ${allResults.length} records</span>`);
            
            // Display results
            this.displayBulkResults(allResults, searchCriteria.length);
            this.updateMap(allMapFeatures, hasGeometry);

        } catch (error) {
            console.error('Error in bulk search:', error);
            $('#csv-status').html(`<span style="color: #dc3545;">Error: ${error.message}</span>`);
        } finally {
            $('#loading').hide();
        }
    }

    async searchSingleCriteria(criteria) {
        const safeVillageName = criteria.village.replace(/[^a-zA-Z0-9-_]/g, '_');
        const tableName = `village_${safeVillageName}`;
        
        // Load village file if not already loaded
        if (!this.loadedFiles.has(tableName)) {
            await this.loadParquetFile(`${criteria.village}.parquet`, tableName);
        }

        const connection = await this.db.connect();
        
        try {
            let whereClause = '';
            let filters = [];
            
            // Add taluka filter to ensure we match the correct taluka
            if (criteria.taluka) {
                const escapedTaluka = criteria.taluka.replace(/'/g, "''");
                filters.push(`taluka = '${escapedTaluka}'`);
            }
            
            if (criteria.survey) {
                const escapedSurvey = criteria.survey.replace(/'/g, "''");
                filters.push(`survey = '${escapedSurvey}'`);
            }
            
            if (criteria.subdiv) {
                const escapedSubdiv = criteria.subdiv.replace(/'/g, "''");
                filters.push(`subdiv = '${escapedSubdiv}'`);
            }
            
            if (filters.length > 0) {
                whereClause = 'WHERE ' + filters.join(' AND ');
            }

            let result;
            if (this.spatialEnabled) {
                try {
                    result = await connection.query(`
                        SELECT taluka, village, survey, subdiv, 
                               ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson,
                               COUNT(*) as record_count
                        FROM ${tableName}
                        ${whereClause}
                        GROUP BY taluka, village, survey, subdiv, geometry
                        ORDER BY survey, subdiv
                        LIMIT 100
                    `);
                } catch (spatialError) {
                    result = await connection.query(`
                        SELECT taluka, village, survey, subdiv, 
                               'WKB Binary Geometry Data (Spatial functions failed)' as geometry_geojson,
                               COUNT(*) as record_count
                        FROM ${tableName}
                        ${whereClause}
                        GROUP BY taluka, village, survey, subdiv
                        ORDER BY survey, subdiv
                        LIMIT 100
                    `);
                }
            } else {
                result = await connection.query(`
                    SELECT taluka, village, survey, subdiv, 
                           'WKB Binary Geometry Data (Spatial extension not available in DuckDB WASM)' as geometry_geojson,
                           COUNT(*) as record_count
                    FROM ${tableName}
                    ${whereClause}
                    GROUP BY taluka, village, survey, subdiv
                    ORDER BY survey, subdiv
                    LIMIT 100
                `);
            }

            const data = result.toArray();
            const mapFeatures = [];
            let hasGeometry = false;

            // Process geometry data for map
            data.forEach(row => {
                if (row.geometry_geojson && !row.geometry_geojson.includes('WKB Binary')) {
                    try {
                        const geometryString = typeof row.geometry_geojson === 'string' 
                            ? row.geometry_geojson 
                            : JSON.stringify(row.geometry_geojson);
                        
                        const geojsonGeometry = JSON.parse(geometryString);
                        if (geojsonGeometry && geojsonGeometry.type) {
                            const safeProperties = {
                                taluka: String(row.taluka || ''),
                                village: String(row.village || ''),
                                survey: String(row.survey || ''),
                                subdiv: String(row.subdiv || ''),
                                records: typeof row.record_count === 'bigint' ? Number(row.record_count) : row.record_count
                            };
                            
                            mapFeatures.push({
                                type: 'Feature',
                                geometry: geojsonGeometry,
                                properties: safeProperties
                            });
                            hasGeometry = true;
                        }
                    } catch (parseError) {
                        console.warn('Could not parse geometry as GeoJSON:', parseError);
                    }
                }
            });

            return { data, mapFeatures, hasGeometry };

        } finally {
            await connection.close();
        }
    }

    displayBulkResults(data, searchCount) {
        if (data.length === 0) {
            $('#results').html('<p>No data found for the search criteria</p>');
            return;
        }

        let html = `
            <h3>Bulk Search Results (${data.length} records from ${searchCount} searches)</h3>
            <p style="font-size: 12px; color: #666; margin-bottom: 10px;">💡 Click on any row to zoom to that parcel on the map</p>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Taluka</th>
                            <th>Village</th>
                            <th>Survey</th>
                            <th>Subdiv</th>
                            <th>Records</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        // Initialize geometry data storage if not exists
        if (!window.geometryData) {
            window.geometryData = {};
        }

        data.forEach((row, index) => {
            let geometryDisplay = '';
            let hasValidGeometry = false;
            let geometryForZoom = null;
            
            if (row.geometry_geojson) {
                const geometryId = `bulk-geometry-${index}`;
                
                let geometryString = '';
                let geojsonGeometry = null;
                
                try {
                    if (typeof row.geometry_geojson === 'string') {
                        geometryString = row.geometry_geojson;
                    } else if (typeof row.geometry_geojson === 'object') {
                        geometryString = JSON.stringify(row.geometry_geojson);
                    } else {
                        geometryString = String(row.geometry_geojson);
                    }
                    
                    // Check if this is valid GeoJSON for zoom functionality
                    if (geometryString && !geometryString.includes('WKB Binary')) {
                        try {
                            geojsonGeometry = JSON.parse(geometryString);
                            if (geojsonGeometry && geojsonGeometry.type) {
                                hasValidGeometry = true;
                                geometryForZoom = geojsonGeometry;
                                
                                // Store geometry data for button/download access
                                const safeVillage = String(row.village || 'village');
                                const safeSurvey = String(row.survey || 'survey');
                                const safeSubdiv = String(row.subdiv || 'subdiv');
                                const baseName = `${safeVillage}_${safeSurvey}_${safeSubdiv}`.replace(/[^a-zA-Z0-9_-]+/g, '_');
                                // Ensure uniqueness even when survey + subdiv repeat
                                const filename = `${baseName}_(${index + 1})`;
                                
                                window.geometryData[geometryId] = {
                                    geojson: JSON.stringify(geojsonGeometry, null, 2),
                                    geometry: geojsonGeometry,
                                    filename
                                };
                            }
                        } catch (parseError) {
                            console.warn('Could not parse geometry as GeoJSON:', parseError);
                        }
                    }
                } catch (e) {
                    console.error('Error processing geometry:', e);
                }
                
                if (hasValidGeometry) {
                    geometryDisplay = `
                        <div style="display: flex; gap: 8px;">
                            <button onclick="copyKML('${geometryId}')" 
                                    style="padding: 6px 12px; font-size: 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                Download KML
                            </button>
                            <button onclick="copyGeoJSON('${geometryId}')" 
                                    style="padding: 6px 12px; font-size: 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                Copy GeoJSON
                            </button>
                        </div>
                    `;
                } else {
                    geometryDisplay = '<em>No geometry data</em>';
                }
            } else {
                geometryDisplay = '<em>No geometry data</em>';
            }

            // Create row with click handler for zoom functionality
            const rowClass = hasValidGeometry ? 'clickable-row' : '';
            const rowStyle = hasValidGeometry ? 'cursor: pointer; transition: background-color 0.2s;' : '';
            const onClickHandler = hasValidGeometry ? `onclick="window.cadastralApp.zoomToGeometry(${JSON.stringify(geometryForZoom).replace(/"/g, '&quot;')})"` : '';

            html += `
                <tr class="${rowClass}" style="${rowStyle}" ${onClickHandler}
                    onmouseover="if(this.classList.contains('clickable-row')) this.style.backgroundColor='#f8f9fa'" 
                    onmouseout="if(this.classList.contains('clickable-row')) this.style.backgroundColor=''">
                    <td>${row.taluka}</td>
                    <td>${row.village}</td>
                    <td>${row.survey}</td>
                    <td>${row.subdiv}</td>
                    <td>${row.record_count}</td>
                    <td onclick="event.stopPropagation()">${geometryDisplay}</td>
                </tr>
            `;
        });

        html += '</tbody></table></div>';
        
        $('#results').html(html);
    }

    // Add method to zoom to specific geometry
    zoomToGeometry(geometry) {
        if (!this.map || !geometry) {
            console.warn('Map not ready or no geometry provided');
            return;
        }

        try {
            const bounds = new google.maps.LatLngBounds();
            
            if (geometry.type === 'Polygon') {
                geometry.coordinates[0].forEach(coord => {
                    bounds.extend({ lat: coord[1], lng: coord[0] });
                });
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates.forEach(polygon => {
                    polygon[0].forEach(coord => {
                        bounds.extend({ lat: coord[1], lng: coord[0] });
                    });
                });
            } else if (geometry.type === 'Point') {
                bounds.extend({ lat: geometry.coordinates[1], lng: geometry.coordinates[0] });
                // For points, add some padding since a single point doesn't create bounds
                const padding = 0.001; // roughly 100m
                bounds.extend({ lat: geometry.coordinates[1] - padding, lng: geometry.coordinates[0] - padding });
                bounds.extend({ lat: geometry.coordinates[1] + padding, lng: geometry.coordinates[0] + padding });
            }

            // Zoom to the bounds with some padding
            this.map.fitBounds(bounds, { padding: 100 });

            // Show map container if it's hidden
            $('#map-container').show();

        } catch (error) {
            console.error('Error zooming to geometry:', error);
        }
    }
}

// Global functions for downloading KML and copying GeoJSON
window.copyKML = function(geometryId) {
    const geometryData = window.geometryData && window.geometryData[geometryId];
    if (!geometryData || !geometryData.geometry) {
        alert('No geometry data available');
        return;
    }
    
    // Create a Feature for tokml (it expects a Feature or FeatureCollection)
    const feature = {
        type: 'Feature',
        geometry: geometryData.geometry,
        properties: {}
    };
    
    // Use tokml library if available
    let kml;
    if (typeof tokml !== 'undefined') {
        kml = tokml(feature);
    } else {
        alert('KML converter library not loaded');
        return;
    }
    
    // Determine filename for download
    const baseName = geometryData.filename || 'parcel';
    const fileName = `${baseName}.kml`;
    
    // Create a blob and trigger download
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// Master download: ZIP containing KML + GeoJSON for all visible plots
window.downloadAllGeometries = function() {
    if (!window.currentGeometryIds || window.currentGeometryIds.length === 0) {
        alert('No plots with geometry available to download');
        return;
    }

    if (typeof JSZip === 'undefined') {
        alert('ZIP library (JSZip) not loaded');
        return;
    }

    if (typeof tokml === 'undefined') {
        alert('KML converter library (tokml) not loaded');
        return;
    }

    const zip = new JSZip();
    let filesAdded = 0;

    window.currentGeometryIds.forEach((geometryId, index) => {
        const geometryData = window.geometryData && window.geometryData[geometryId];
        if (!geometryData || !geometryData.geometry || !geometryData.geojson) {
            return;
        }

        const baseName = geometryData.filename || `plot_${index + 1}`;
        const folder = zip.folder(baseName);

        // Prepare GeoJSON content
        const geojsonContent = geometryData.geojson;
        folder.file(`${baseName}.geojson`, geojsonContent);

        // Prepare KML content via tokml
        const feature = {
            type: 'Feature',
            geometry: geometryData.geometry,
            properties: {}
        };
        const kmlContent = tokml(feature);
        folder.file(`${baseName}.kml`, kmlContent);

        filesAdded += 2;
    });

    if (filesAdded === 0) {
        alert('No geometry data available to include in ZIP');
        return;
    }

    zip.generateAsync({ type: 'blob' }).then((content) => {
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'plots_kml_geojson.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch((err) => {
        console.error('Error generating ZIP:', err);
        alert('Failed to generate ZIP file');
    });
};

window.copyGeoJSON = function(geometryId) {
    const geometryData = window.geometryData && window.geometryData[geometryId];
    if (!geometryData || !geometryData.geojson) {
        alert('No geometry data available');
        return;
    }
    
    const geojson = geometryData.geojson;
    const button = event.target;
    
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(geojson).then(() => {
            const originalText = button.textContent;
            button.textContent = 'Copied!';
            button.style.backgroundColor = '#198754';
            setTimeout(() => {
                button.textContent = originalText;
                button.style.backgroundColor = '#28a745';
            }, 1500);
        }).catch(err => {
            console.error('Failed to copy: ', err);
            alert('Failed to copy to clipboard');
        });
    } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = geojson;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('GeoJSON copied to clipboard!');
    }
};

// Initialize the app when DOM is ready and Google Maps is loaded
function initializeApp() {
    if (window.google && window.google.maps) {
        // Google Maps is already loaded
        window.cadastralApp = new CadastralDataApp();
    } else {
        // Wait for Google Maps to load
        window.addEventListener('googlemapsloaded', () => {
            window.cadastralApp = new CadastralDataApp();
        }, { once: true });
    }
}

// Wait for DOM to be ready before initializing
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM is already ready
    initializeApp();
}