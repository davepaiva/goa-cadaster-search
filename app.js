import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";
import * as turf from "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/+esm";

class CadastralDataApp {
    constructor() {
        this.db = null;
        this.loadedFiles = new Set();
        this.map = null;
        this.mapPolygons = [];
        this.mapInfoWindows = [];
        this.features = [];
        this.customProperties = [];
        this.plotIdCounter = 0;
        this.usedKeys = new Set();
        this.usedValues = new Set();
        this.rowsWithMissingGeojson = [];
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
            this.updateExportControls();
            
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

    /** DuckDB identifiers cannot contain hyphens; keep letters, digits, underscore only. */
    villageTableName(villageName) {
        const suffix = String(villageName).replace(/[^a-zA-Z0-9_]/g, '_');
        return `village_${suffix}`;
    }

    async loadParquetFile(filename, tableName) {
        if (this.loadedFiles.has(tableName)) {
            console.log(`${tableName} already loaded, skipping`);
            return; // Already loaded
        }

        console.log(`Loading ${filename} as table ${tableName}...`);
        const connection = await this.db.connect();
        
        try {
            const encodedFilename = encodeURIComponent(filename);
            // Try multiple URL strategies for GitHub Pages compatibility
            const urlStrategies = [
                // Strategy 1: Current approach
                () => {
                    const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '');
                    return `${baseUrl}/data/${encodedFilename}`;
                },
                // Strategy 2: Direct relative path (for GitHub Pages root deployment)
                () => `./data/${encodedFilename}`,
                // Strategy 3: Absolute path from root
                () => `${window.location.origin}${window.location.pathname.split('/').slice(0, -1).join('/')}/data/${encodedFilename}`,
                // Strategy 4: Using repo name if available
                () => {
                    const pathParts = window.location.pathname.split('/').filter(p => p);
                    if (pathParts.length > 0) {
                        return `${window.location.origin}/${pathParts[0]}/data/${encodedFilename}`;
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
                    // HEAD can fail (405/500) on some static servers while GET (used by DuckDB) still works.
                    try {
                        const response = await fetch(fileUrl, { method: 'HEAD' });
                        console.log(`File check for ${filename}: Status ${response.status}, Content-Length: ${response.headers.get('content-length')}, Content-Type: ${response.headers.get('content-type')}`);

                        if (response.ok) {
                            const contentLength = response.headers.get('content-length');
                            if (contentLength === '0' || contentLength === null) {
                                console.warn(`Warning: File ${filename} appears to be empty or content-length not set`);
                            }
                        } else if (response.status === 404 || response.status === 403) {
                            throw new Error(`File not accessible: HTTP ${response.status} ${response.statusText}`);
                        } else {
                            console.warn(`HEAD returned HTTP ${response.status}; continuing with read_parquet (GET may still succeed).`);
                        }
                    } catch (headError) {
                        if (headError.message && headError.message.includes('File not accessible')) {
                            throw headError;
                        }
                        console.warn(`HEAD failed for ${fileUrl}:`, headError.message, '- trying read_parquet anyway.');
                    }

                    const escapedUrl = fileUrl.replace(/'/g, "''");
                    await connection.query(`
                        CREATE TABLE ${tableName} AS 
                        SELECT * FROM read_parquet('${escapedUrl}')
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
            const tableName = this.villageTableName(villageName);

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
            const tableName = this.villageTableName(villageName);

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

    clearMapPolygons() {
        this.mapPolygons.forEach(polygon => polygon.setMap(null));
        this.mapPolygons = [];
        this.mapInfoWindows.forEach(iw => iw.close());
        this.mapInfoWindows = [];
    }

    countFeaturesWithGeometry() {
        return this.features.filter(f => f.geometry && f.geometry !== null).length;
    }

    updateExportControls() {
        const n = this.countFeaturesWithGeometry();
        const anyFeatures = this.features.length > 0;
        $('#export-button').prop('disabled', n === 0);
        $('#download-all-zip').prop('disabled', n === 0);
        $('#clear-all-btn').prop('disabled', !anyFeatures);
    }

    refreshAfterFeatureChange() {
        this.displayResults();
        try {
            this.displayOnMap();
        } catch (e) {
            console.warn('Map refresh:', e);
        }
        this.updateExportControls();
        $('#plot-count').text(String(this.features.length));
        if (this.features.length === 0) {
            $('#results-section').hide();
            $('#table-empty-state').show();
        } else {
            $('#results-section').show();
            $('#table-empty-state').hide();
        }
    }

    changePolygonColor(plotId, newColor) {
        const f = this.features.find(x => x.properties._plotId === plotId);
        if (f && f.properties) {
            f.properties._polygonColor = newColor;
            this.displayOnMap();
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

    parseCsvLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim());
        return values;
    }

    parseCsv(csvText) {
        const lines = csvText.trim().split('\n');
        if (lines.length < 2) {
            throw new Error('CSV must have at least a header row and one data row');
        }
        const headers = lines[0].split(',').map(h => h.trim());
        const lowerHeaders = headers.map(h => h.toLowerCase());
        const talukaIndex = lowerHeaders.indexOf('taluka');
        const villageIndex = lowerHeaders.indexOf('village');
        const surveyIndex = lowerHeaders.indexOf('survey');
        const subdivIndex = lowerHeaders.indexOf('subdiv');
        if (villageIndex === -1) {
            throw new Error('CSV must have a "village" column');
        }
        const standardIndices = [talukaIndex, villageIndex, surveyIndex, subdivIndex].filter(i => i !== -1);
        const customPropertyIndices = headers.map((h, i) => i).filter(i => !standardIndices.includes(i));
        const customProperties = customPropertyIndices.map(i => headers[i]);
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const values = this.parseCsvLine(line);
            if (values.length >= headers.length && values[villageIndex]) {
                let survey = surveyIndex !== -1 ? values[surveyIndex] : null;
                let subdiv = subdivIndex !== -1 ? values[subdivIndex] : null;
                let originalSurvey = survey;
                if (survey && survey.includes('/')) {
                    const hasExplicitSubdiv = subdivIndex !== -1 && subdiv && subdiv.trim() !== '';
                    if (!hasExplicitSubdiv) {
                        const parts = survey.split('/');
                        survey = parts[0].trim();
                        subdiv = parts.length > 1 ? parts[1].trim() : '';
                    }
                }
                if (survey !== null && survey.trim() === '') survey = null;
                if (subdiv !== null && subdiv.trim() === '') subdiv = null;
                const rowData = {
                    taluka: talukaIndex !== -1 ? values[talukaIndex] : null,
                    village: values[villageIndex],
                    survey,
                    subdiv,
                    _originalSurvey: originalSurvey,
                    customProperties: {},
                    _csvRowIndex: i
                };
                customPropertyIndices.forEach(index => {
                    rowData.customProperties[headers[index]] = values[index] || '';
                });
                rows.push(rowData);
            }
        }
        return { rows, customProperties };
    }

    async searchSingleRow(row) {
        const tableName = this.villageTableName(row.village);
        if (!this.loadedFiles.has(tableName)) {
            await this.loadParquetFile(`${row.village}.parquet`, tableName);
        }
        const connection = await this.db.connect();
        try {
            if (!row.taluka) {
                try {
                    const talukaResult = await connection.query(`SELECT DISTINCT taluka FROM ${tableName} LIMIT 1`);
                    const talukaData = talukaResult.toArray();
                    if (talukaData.length > 0 && talukaData[0].taluka) {
                        row.taluka = talukaData[0].taluka;
                    }
                } catch (e) {
                    console.warn('Could not auto-detect taluka:', e);
                }
            }
            const originalSurvey = row._originalSurvey || row.survey;
            let filters = [];
            if (row.taluka) {
                const escapedTaluka = row.taluka.replace(/'/g, "''");
                filters.push(`LOWER(taluka) = LOWER('${escapedTaluka}')`);
            }
            if (row.survey) {
                const escapedSurvey = row.survey.replace(/'/g, "''");
                filters.push(`survey = '${escapedSurvey}'`);
            }
            if (row.subdiv !== null && row.subdiv !== undefined && row.subdiv !== '') {
                const escapedSubdiv = row.subdiv.replace(/'/g, "''");
                filters.push(`REPLACE(subdiv, '-', '') = REPLACE('${escapedSubdiv}', '-', '')`);
            }
            const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
            let result;
            let sqlQuery = '';
            if (this.spatialEnabled) {
                try {
                    sqlQuery = `SELECT taluka, village, survey, subdiv, ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson FROM ${tableName} ${whereClause} LIMIT 100`;
                    result = await connection.query(sqlQuery);
                } catch (spatialError) {
                    console.error('Spatial query failed:', spatialError);
                    return [];
                }
            } else {
                return [];
            }
            let data = result.toArray();
            if (data.length === 0 && originalSurvey && originalSurvey.includes('/') && row.survey !== originalSurvey) {
                let combinedFilters = [];
                if (row.taluka) {
                    const escapedTaluka = row.taluka.replace(/'/g, "''");
                    combinedFilters.push(`LOWER(taluka) = LOWER('${escapedTaluka}')`);
                }
                const escapedOriginalSurvey = originalSurvey.replace(/'/g, "''");
                combinedFilters.push(`survey = '${escapedOriginalSurvey}'`);
                const combinedWhere = combinedFilters.length > 0 ? 'WHERE ' + combinedFilters.join(' AND ') : '';
                const combinedSql = `SELECT taluka, village, survey, subdiv, ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson FROM ${tableName} ${combinedWhere} LIMIT 100`;
                try {
                    result = await connection.query(combinedSql);
                    data = result.toArray();
                } catch (e) {
                    console.error('Combined format query failed:', e);
                }
            }
            return this.processQueryResults(data, row);
        } finally {
            await connection.close();
        }
    }

    processQueryResults(data, row) {
        const features = [];
        data.forEach((dbRow) => {
            if (!dbRow.geometry_geojson) return;
            try {
                const geometryString = typeof dbRow.geometry_geojson === 'string'
                    ? dbRow.geometry_geojson
                    : JSON.stringify(dbRow.geometry_geojson);
                const geojsonGeometry = JSON.parse(geometryString);
                if (geojsonGeometry && geojsonGeometry.type) {
                    const properties = {
                        taluka: String(dbRow.taluka || ''),
                        village: String(dbRow.village || ''),
                        survey: String(dbRow.survey || ''),
                        subdiv: String(dbRow.subdiv || ''),
                        _plotId: `plot_${this.plotIdCounter++}`,
                        _polygonColor: '#007cba',
                        ...(row.customProperties || {})
                    };
                    features.push({
                        type: 'Feature',
                        geometry: geojsonGeometry,
                        properties
                    });
                }
            } catch (parseError) {
                console.warn('Could not parse geometry:', parseError);
            }
        });
        return features;
    }

    async searchAndDisplay(rows, append) {
        if (!append) {
            this.features = [];
            this.rowsWithMissingGeojson = [];
            this.plotIdCounter = 0;
        }
        const missingBefore = this.rowsWithMissingGeojson.length;
        let totalPlotsFound = 0;
        for (const row of rows) {
            try {
                const results = await this.searchSingleRow(row);
                if (results.length > 0) {
                    results.forEach(r => this.features.push(r));
                    totalPlotsFound += results.length;
                } else {
                    const missingFeature = {
                        type: 'Feature',
                        geometry: null,
                        properties: {
                            taluka: row.taluka || 'Unknown',
                            village: row.village,
                            survey: row.survey || '-',
                            subdiv: row.subdiv || 'All',
                            _plotId: `plot_${this.plotIdCounter++}`,
                            _polygonColor: '#007cba',
                            _missingGeojson: true,
                            _csvRowIndex: row._csvRowIndex,
                            ...(row.customProperties || {})
                        }
                    };
                    this.features.push(missingFeature);
                    this.rowsWithMissingGeojson.push(missingFeature);
                }
            } catch (error) {
                const errorFeature = {
                    type: 'Feature',
                    geometry: null,
                    properties: {
                        taluka: row.taluka || 'Unknown',
                        village: row.village,
                        survey: row.survey || '-',
                        subdiv: row.subdiv || 'All',
                        _plotId: `plot_${this.plotIdCounter++}`,
                        _polygonColor: '#007cba',
                        _missingGeojson: true,
                        _error: error.message,
                        _csvRowIndex: row._csvRowIndex,
                        ...(row.customProperties || {})
                    }
                };
                this.features.push(errorFeature);
                this.rowsWithMissingGeojson.push(errorFeature);
            }
        }
        const newMissing = this.rowsWithMissingGeojson.length - missingBefore;
        if (this.features.length === 0) {
            $('#csv-status').html('<span style="color:#dc3545;">No data to display</span>');
            alert('No data to display. Please check your CSV data.');
            return;
        }
        let statusMessage = `<span style="color:#28a745;">✓ Added ${totalPlotsFound} plot(s) from ${rows.length} CSV row(s)</span>`;
        if (newMissing > 0) {
            statusMessage += ` <span style="color:#ff9800;">⚠ ${newMissing} row(s) with no geometry</span>`;
        }
        $('#csv-status').html(statusMessage);
        this.refreshAfterFeatureChange();
    }

    async addPlotFromDropdowns() {
        const taluka = $('#taluka-dropdown').val();
        const village = $('#village-dropdown').val();
        let survey = $('#survey-dropdown').val();
        let subdiv = $('#subdiv-dropdown').val();
        if (!village) {
            alert('Please select a village first');
            return;
        }
        if (!survey || survey.trim() === '') survey = null;
        if (!subdiv || subdiv.trim() === '') subdiv = null;
        $('#loading').show();
        try {
            const rowData = {
                taluka: taluka || null,
                village,
                survey,
                subdiv,
                customProperties: {}
            };
            const results = await this.searchSingleRow(rowData);
            if (results.length === 0) {
                const missingFeature = {
                    type: 'Feature',
                    geometry: null,
                    properties: {
                        taluka: rowData.taluka || 'Unknown',
                        village: rowData.village,
                        survey: rowData.survey || '-',
                        subdiv: rowData.subdiv || '-',
                        _plotId: `plot_${this.plotIdCounter++}`,
                        _polygonColor: '#007cba',
                        _missingGeojson: true
                    }
                };
                this.features.push(missingFeature);
                this.rowsWithMissingGeojson.push(missingFeature);
                $('#csv-status').html('<span style="color:#ff9800;">No geometry found — row added for review</span>');
            } else {
                results.forEach(r => this.features.push(r));
                $('#csv-status').html(`<span style="color:#28a745;">✓ Added ${results.length} plot(s)</span>`);
            }
            this.refreshAfterFeatureChange();
        } catch (error) {
            console.error(error);
            alert('Error adding plot: ' + error.message);
        } finally {
            $('#loading').hide();
        }
    }

    collectUsedKeysAndValues() {
        this.usedKeys.clear();
        this.usedValues.clear();
        const standardProps = ['taluka', 'village', 'survey', 'subdiv', '_plotId', '_polygonColor', '_missingGeojson', '_error', '_csvRowIndex'];
        this.features.forEach(feature => {
            Object.keys(feature.properties).forEach(key => {
                if (!standardProps.includes(key)) {
                    this.usedKeys.add(key);
                    const value = feature.properties[key];
                    if (value) this.usedValues.add(String(value));
                }
            });
        });
    }

    updateDataLists() {
        $('#keys-datalist').remove();
        $('#values-datalist').remove();
        let keysDatalist = '<datalist id="keys-datalist">';
        this.usedKeys.forEach(key => { keysDatalist += `<option value="${key.replace(/"/g, '&quot;')}">`; });
        keysDatalist += '</datalist>';
        let valuesDatalist = '<datalist id="values-datalist">';
        this.usedValues.forEach(value => { valuesDatalist += `<option value="${String(value).replace(/"/g, '&quot;')}">`; });
        valuesDatalist += '</datalist>';
        $('body').append(keysDatalist);
        $('body').append(valuesDatalist);
    }

    escapeAttr(s) {
        return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    displayResults() {
        this.collectUsedKeysAndValues();
        const tbody = $('#results-table-body');
        tbody.empty();
        this.updateDataLists();
        const internalForProps = ['taluka', 'village', 'survey', 'subdiv', '_plotId', '_polygonColor', '_missingGeojson', '_error', '_csvRowIndex'];
        this.features.forEach((feature) => {
            const props = feature.properties;
            const plotId = props._plotId;
            const hasMissing = props._missingGeojson === true;
            const hasGeom = !!(feature.geometry && feature.geometry !== null);
            const customKeys = Object.keys(props).filter(k => !internalForProps.includes(k));
            let propertyHtml = '<div class="property-list" id="property-list-' + plotId + '" onclick="event.stopPropagation()">';
            customKeys.forEach(key => {
                const ek = this.escapeAttr(key);
                const ev = this.escapeAttr(props[key]);
                propertyHtml += `
                    <div class="property-item">
                        <input type="text" list="keys-datalist" value="${String(key).replace(/"/g, '&quot;')}" placeholder="Key"
                            onchange="window.cadastralApp.updatePropertyKey('${plotId}', '${ek}', this.value)" style="width:100px;">
                        <input type="text" list="values-datalist" value="${String(props[key] || '').replace(/"/g, '&quot;')}" placeholder="Value"
                            onchange="window.cadastralApp.updatePropertyValue('${plotId}', '${ek}', this.value)" style="width:120px;">
                        <button type="button" onclick="window.cadastralApp.removeProperty('${plotId}', '${ek}')">×</button>
                    </div>`;
            });
            propertyHtml += `<button type="button" class="add-property-btn" onclick="window.cadastralApp.addProperty('${plotId}')">+ Add property</button></div>`;
            let warningHtml = '';
            if (hasMissing) {
                warningHtml = '<div class="warning-indicator">No map data</div>';
            }
            const rowClass = (hasMissing ? 'missing-geojson ' : '') + (hasGeom ? 'clickable-row' : '');
            const zoomAttr = hasGeom ? `onclick="window.cadastralApp.zoomToPlot('${plotId}')"` : '';
            const actionsHtml = `<button type="button" class="kebab-btn" title="Actions" onclick="event.stopPropagation();window.openActionsModal('${plotId}')">&#8942;</button>`;
            tbody.append(`
                <tr class="${rowClass}" ${zoomAttr}>
                    <td>${props.taluka}${hasMissing ? '<br>' + warningHtml : ''}</td>
                    <td>${props.village}</td>
                    <td>${props.survey || '-'}</td>
                    <td>${props.subdiv || '-'}</td>
                    <td>${propertyHtml}</td>
                    <td>${actionsHtml}</td>
                </tr>`);
        });
        $('#results-table-container').show();
    }

    displayOnMap() {
        this.clearMapPolygons();
        if (!this.map) return;
        const bounds = new google.maps.LatLngBounds();
        let hasValid = false;
        this.features.forEach((feature) => {
            try {
                const geometry = feature.geometry;
                if (!geometry) return;
                let paths = [];
                if (geometry.type === 'Polygon') {
                    paths = geometry.coordinates[0].map(c => ({ lat: c[1], lng: c[0] }));
                } else if (geometry.type === 'MultiPolygon') {
                    paths = geometry.coordinates[0][0].map(c => ({ lat: c[1], lng: c[0] }));
                } else return;
                const color = feature.properties._polygonColor || '#007cba';
                const polygon = new google.maps.Polygon({
                    paths,
                    strokeColor: color,
                    strokeOpacity: 1,
                    strokeWeight: 2,
                    fillColor: color,
                    fillOpacity: 0.3,
                    map: this.map
                });
                const internalProps = ['_plotId', '_missingGeojson', '_error', '_csvRowIndex', '_polygonColor'];
                let infoContent = '<div style="font-size:12px;max-width:300px;"><strong>Plot</strong><br><br>';
                Object.keys(feature.properties).forEach(key => {
                    if (!internalProps.includes(key)) {
                        const v = feature.properties[key];
                        if (v !== undefined && v !== null && v !== '') {
                            infoContent += `<strong>${key}:</strong> ${v}<br>`;
                        }
                    }
                });
                infoContent += '</div>';
                const infoWindow = new google.maps.InfoWindow({ content: infoContent });
                polygon.addListener('click', (event) => {
                    this.mapInfoWindows.forEach(iw => iw.close());
                    infoWindow.setPosition(event.latLng);
                    infoWindow.open(this.map);
                });
                this.mapPolygons.push(polygon);
                this.mapInfoWindows.push(infoWindow);
                paths.forEach(p => bounds.extend(p));
                hasValid = true;
            } catch (e) {
                console.warn('Map feature error:', e);
            }
        });
        if (hasValid && this.mapPolygons.length > 0) {
            this.map.fitBounds(bounds, { padding: 50 });
        }
    }

    zoomToPlot(plotId) {
        const f = this.features.find(x => x.properties._plotId === plotId);
        if (f && f.geometry) this.zoomToGeometry(f.geometry);
    }

    zoomToGeometry(geometry) {
        if (!this.map || !geometry) return;
        try {
            const bounds = new google.maps.LatLngBounds();
            if (geometry.type === 'Polygon') {
                geometry.coordinates[0].forEach(c => bounds.extend({ lat: c[1], lng: c[0] }));
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates.forEach(poly => poly[0].forEach(c => bounds.extend({ lat: c[1], lng: c[0] })));
            } else if (geometry.type === 'Point') {
                const pad = 0.001;
                bounds.extend({ lat: geometry.coordinates[1], lng: geometry.coordinates[0] });
                bounds.extend({ lat: geometry.coordinates[1] - pad, lng: geometry.coordinates[0] - pad });
                bounds.extend({ lat: geometry.coordinates[1] + pad, lng: geometry.coordinates[0] + pad });
            }
            this.map.fitBounds(bounds, { padding: 100 });
        } catch (e) {
            console.error(e);
        }
    }

    addProperty(plotId) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;
        let finalKey = 'new_property';
        let c = 1;
        while (feature.properties.hasOwnProperty(finalKey)) {
            finalKey = `new_property_${c++}`;
        }
        feature.properties[finalKey] = '';
        this.refreshAfterFeatureChange();
    }

    removeProperty(plotId, key) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;
        delete feature.properties[key];
        this.refreshAfterFeatureChange();
    }

    updatePropertyKey(plotId, oldKey, newKey) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;
        const reserved = ['taluka', 'village', 'survey', 'subdiv', '_plotId', '_polygonColor', '_missingGeojson', '_error', '_csvRowIndex'];
        if (newKey && newKey !== oldKey && !reserved.includes(newKey) && !newKey.startsWith('_')) {
            const v = feature.properties[oldKey];
            delete feature.properties[oldKey];
            feature.properties[newKey] = v;
            this.refreshAfterFeatureChange();
        }
    }

    updatePropertyValue(plotId, key, value) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;
        feature.properties[key] = value;
        if (value) this.usedValues.add(String(value));
        this.displayOnMap();
    }

    removePlot(plotId) {
        const idx = this.features.findIndex(f => f.properties._plotId === plotId);
        if (idx > -1) this.features.splice(idx, 1);
        this.rowsWithMissingGeojson = this.rowsWithMissingGeojson.filter(f => f.properties._plotId !== plotId);
        this.refreshAfterFeatureChange();
    }

    clearAll() {
        if (!confirm('Clear all plots from the map and table?')) return;
        this.features = [];
        this.customProperties = [];
        this.plotIdCounter = 0;
        this.usedKeys.clear();
        this.usedValues.clear();
        this.rowsWithMissingGeojson = [];
        $('#results-table-body').empty();
        $('#csv-upload').val('');
        $('#csv-status').text('');
        $('#process-csv').prop('disabled', true);
        $('#keys-datalist').remove();
        $('#values-datalist').remove();
        this.clearMapPolygons();
        $('#results-section').hide();
        $('#table-empty-state').show();
        $('#taluka-dropdown').val('');
        $('#village-dropdown').prop('disabled', true).empty().append('<option value="">Select Village</option>');
        $('#survey-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey No (Optional)</option>');
        $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Subdiv (Optional)</option>');
        $('#add-plot-button').prop('disabled', true);
        this.updateExportControls();
        $('#plot-count').text('0');
    }

    cleanPropsForExport(props) {
        const out = {};
        Object.keys(props).forEach(k => {
            if (!k.startsWith('_')) out[k] = props[k];
        });
        return out;
    }

    exportGeoJSON() {
        const cleaned = this.features
            .filter(f => f.geometry)
            .map(f => ({
                type: 'Feature',
                geometry: f.geometry,
                properties: this.cleanPropsForExport(f.properties)
            }));
        if (cleaned.length === 0) {
            alert('No plots with geometry to export.');
            return;
        }
        const fc = { type: 'FeatureCollection', features: cleaned };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'goa_cadastral_plots.geojson';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert(`GeoJSON downloaded (${cleaned.length} plot(s)).`);
    }

    exportKML() {
        if (typeof tokml === 'undefined') {
            alert('KML library not loaded');
            return;
        }
        const cleaned = this.features
            .filter(f => f.geometry)
            .map(f => ({
                type: 'Feature',
                geometry: f.geometry,
                properties: this.cleanPropsForExport(f.properties)
            }));
        if (cleaned.length === 0) {
            alert('No plots with geometry to export.');
            return;
        }
        const fc = { type: 'FeatureCollection', features: cleaned };
        const blob = new Blob([tokml(fc)], { type: 'application/vnd.google-earth.kml+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'goa_cadastral_plots.kml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert(`KML downloaded (${cleaned.length} plot(s)).`);
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
                $('#add-plot-button').prop('disabled', true);
            }
        });

        $('#village-dropdown').on('change', async (e) => {
            const selectedVillage = e.target.value;
            console.log('Village selected:', selectedVillage);
            $('#add-plot-button').prop('disabled', !selectedVillage);
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

        $('#add-plot-button').on('click', () => {
            this.addPlotFromDropdowns();
        });

        $('#clear-all-btn').on('click', () => {
            this.clearAll();
        });

        // View toggle is handled by window.switchView in index.html
    }

    downloadCsvTemplate() {
        const csvContent = 'village,survey,subdiv,taluka,owner_note\n' +
            'Panaji,123,A,Tiswadi,Example note\n' +
            'Margao,99/5-A,,,\n' +
            'Vasco,456,,Mormugao,\n';
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cadastral_template.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        $('#csv-status').html('<span style="color:#28a745;">Template downloaded</span>');
    }

    async processCsvFile() {
        const fileInput = document.getElementById('csv-upload');
        const file = fileInput.files[0];
        if (!file) {
            alert('Please select a CSV file first');
            return;
        }
        $('#csv-status').text('Processing CSV…');
        $('#process-csv').prop('disabled', true);
        $('#loading').show();
        try {
            const csvText = await this.readFileAsText(file);
            const parsed = this.parseCsv(csvText);
            if (parsed.rows.length === 0) {
                $('#csv-status').html('<span style="color:#dc3545;">No valid data in CSV</span>');
                return;
            }
            const merged = new Set([...(this.customProperties || []), ...parsed.customProperties]);
            this.customProperties = [...merged];
            $('#csv-status').text(`Found ${parsed.rows.length} row(s). Searching…`);
            await this.searchAndDisplay(parsed.rows, true);
        } catch (error) {
            console.error(error);
            $('#csv-status').html(`<span style="color:#dc3545;">Error: ${error.message}</span>`);
            alert('Error: ' + error.message);
        } finally {
            $('#process-csv').prop('disabled', false);
            $('#loading').hide();
        }
    }
}

function plotFileBase(props) {
    const v = [props.village, props.survey, props.subdiv].map(x => String(x || '').replace(/[^a-zA-Z0-9_-]+/g, '_')).join('_');
    return v || 'parcel';
}

window.copyKML = function(plotId) {
    const app = window.cadastralApp;
    const f = app && app.features.find(x => x.properties._plotId === plotId);
    if (!f || !f.geometry) {
        alert('No geometry for this plot');
        return;
    }
    if (typeof tokml === 'undefined') {
        alert('KML library not loaded');
        return;
    }
    const props = app.cleanPropsForExport(f.properties);
    const kml = tokml({ type: 'Feature', geometry: f.geometry, properties: props });
    const baseName = plotFileBase(f.properties);
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.kml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

window.downloadAllGeometries = function() {
    const app = window.cadastralApp;
    if (!app || typeof JSZip === 'undefined' || typeof tokml === 'undefined') {
        alert('App or libraries not ready');
        return;
    }
    const withGeom = app.features.filter(f => f.geometry);
    if (withGeom.length === 0) {
        alert('No plots with geometry to download');
        return;
    }
    const zip = new JSZip();
    let n = 0;
    withGeom.forEach((f, index) => {
        const baseName = `${plotFileBase(f.properties)}_${index + 1}`;
        const folder = zip.folder(baseName);
        const props = app.cleanPropsForExport(f.properties);
        const feat = { type: 'Feature', geometry: f.geometry, properties: props };
        folder.file(`${baseName}.geojson`, JSON.stringify(feat, null, 2));
        folder.file(`${baseName}.kml`, tokml(feat));
        n += 2;
    });
    if (n === 0) {
        alert('Nothing to add to ZIP');
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
        console.error(err);
        alert('Failed to generate ZIP');
    });
};

window.copyGeoJSON = function(plotId, button) {
    const app = window.cadastralApp;
    const f = app && app.features.find(x => x.properties._plotId === plotId);
    if (!f || !f.geometry) {
        alert('No geometry for this plot');
        return;
    }
    const clean = {};
    Object.keys(f.properties).forEach(k => {
        if (!k.startsWith('_')) clean[k] = f.properties[k];
    });
    const geojson = JSON.stringify({ type: 'Feature', geometry: f.geometry, properties: clean }, null, 2);
    const btn = button || (typeof event !== 'undefined' ? event.target : null);
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(geojson).then(() => {
            if (btn) {
                const t = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = t; }, 1500);
            }
        }).catch(() => alert('Copy failed'));
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = geojson;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('GeoJSON copied');
    }
};

window.openAmcheLink = function(plotId) {
    const app = window.cadastralApp;
    const f = app && app.features.find(x => x.properties._plotId === plotId);
    if (!f || !f.geometry) {
        alert('No geometry for this plot');
        return;
    }
    try {
        const c = turf.centroid(f.geometry);
        const [lng, lat] = c.geometry.coordinates;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            alert('Could not get centroid');
            return;
        }
        const zoom = 16.44;
        window.open(`https://amche.in/?layers=goa-2021-regional-plan&terrain=1.5#${zoom}/${lat.toFixed(6)}/${lng.toFixed(6)}`, '_blank');
    } catch (e) {
        alert('Could not compute centroid');
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